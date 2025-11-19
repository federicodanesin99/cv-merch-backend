// gmail-parser.js - Parsing automatico email pagamenti PayPal/Revolut
const { google } = require('googleapis');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ==================================
// CONFIGURAZIONE GMAIL API
// ==================================

async function getGmailClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/gmail.readonly']
  });

  const gmail = google.gmail({ version: 'v1', auth });
  return gmail;
}

// ==================================
// PARSING EMAIL PAYPAL
// ==================================

function parsePayPalEmail(subject, body) {
  // Esempio subject: "Hai ricevuto un pagamento di 39,00 EUR da Mario Rossi"
  const amountMatch = body.match(/(\d+[,\.]\d{2})\s*(EUR|€)/i);
  const emailMatch = body.match(/[\w\.-]+@[\w\.-]+\.\w+/g);
  const transactionMatch = body.match(/(?:Numero transazione|Transaction ID):\s*([A-Z0-9]+)/i);
  const orderMatch = body.match(/(?:Ordine|Order)\s*#?(\d{4})/i);

  return {
    amount: amountMatch ? parseFloat(amountMatch[1].replace(',', '.')) : null,
    customerEmail: emailMatch?.[0],
    transactionId: transactionMatch?.[1],
    orderNumber: orderMatch ? parseInt(orderMatch[1]) : null
  };
}

// ==================================
// PARSING EMAIL REVOLUT
// ==================================

function parseRevolutEmail(subject, body) {
  // Esempio: "You received €39.00 from Mario Rossi"
  const amountMatch = body.match(/€?\s*(\d+[,\.]\d{2})/);
  const emailMatch = body.match(/[\w\.-]+@[\w\.-]+\.\w+/g);
  const referenceMatch = body.match(/(?:Reference|Riferimento):\s*(.+?)(?:\n|$)/i);

  return {
    amount: amountMatch ? parseFloat(amountMatch[1].replace(',', '.')) : null,
    customerEmail: emailMatch?.[0],
    reference: referenceMatch?.[1]?.trim(),
    orderNumber: null // Revolut non sempre ha l'ordine in automatico
  };
}

// ==================================
// MATCH ORDINE NEL DATABASE
// ==================================

async function matchOrderWithPayment(paymentData) {
  // Strategia 1: Match per orderNumber (se presente nelle note PayPal)
  if (paymentData.orderNumber) {
    const order = await prisma.order.findFirst({
      where: {
        orderNumber: paymentData.orderNumber,
        paymentStatus: 'PENDING',
        total: paymentData.amount
      }
    });
    if (order) return order;
  }

  // Strategia 2: Match per email + importo + timestamp recente
  const order = await prisma.order.findFirst({
    where: {
      customerEmail: paymentData.customerEmail,
      total: paymentData.amount,
      paymentStatus: 'PENDING',
      createdAt: {
        gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Ultimi 24h
      }
    },
    orderBy: { createdAt: 'desc' }
  });

  return order;
}

// ==================================
// MAIN PARSER FUNCTION
// ==================================

async function checkPayments() {
  console.log('[Gmail Parser] Starting payment check...');

  try {
    const gmail = await getGmailClient();

    // Query per email PayPal non lette
    const paypalQuery = 'from:service@paypal.it subject:"Hai ricevuto un pagamento" is:unread';
    const paypalRes = await gmail.users.messages.list({
      userId: 'me',
      q: paypalQuery,
      maxResults: 10
    });

    // Query per email Revolut non lette
    const revolutQuery = 'from:no-reply@revolut.com subject:"received" is:unread';
    const revolutRes = await gmail.users.messages.list({
      userId: 'me',
      q: revolutQuery,
      maxResults: 10
    });

    const paypalMessages = paypalRes.data.messages || [];
    const revolutMessages = revolutRes.data.messages || [];

    console.log(`[Gmail Parser] Found ${paypalMessages.length} PayPal + ${revolutMessages.length} Revolut emails`);

    // Processa PayPal
    for (const message of paypalMessages) {
      await processPayPalMessage(gmail, message.id);
    }

    // Processa Revolut
    for (const message of revolutMessages) {
      await processRevolutMessage(gmail, message.id);
    }

    console.log('[Gmail Parser] Payment check completed');

  } catch (error) {
    console.error('[Gmail Parser] Error:', error);
    
    // Log errore nel database
    await prisma.paymentLog.create({
      data: {
        source: 'gmail_parser',
        status: 'error',
        rawData: { error: error.message }
      }
    });
  }
}

// ==================================
// PROCESS PAYPAL MESSAGE
// ==================================

async function processPayPalMessage(gmail, messageId) {
  try {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    const headers = msg.data.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    
    // Decodifica body
    let body = '';
    if (msg.data.payload.parts) {
      const textPart = msg.data.payload.parts.find(p => p.mimeType === 'text/plain');
      if (textPart?.body?.data) {
        body = Buffer.from(textPart.body.data, 'base64').toString();
      }
    } else if (msg.data.payload.body?.data) {
      body = Buffer.from(msg.data.payload.body.data, 'base64').toString();
    }

    // Parsing
    const paymentData = parsePayPalEmail(subject, body);
    console.log('[PayPal] Parsed:', paymentData);

    // Match ordine
    const order = await matchOrderWithPayment(paymentData);

    if (order) {
      // Aggiorna ordine
      await prisma.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: 'PAID',
          paymentId: paymentData.transactionId,
          paidAt: new Date()
        }
      });

      console.log(`[PayPal] ✅ Order #${order.orderNumber} marked as PAID`);

      // Log successo
      await prisma.paymentLog.create({
        data: {
          orderId: order.id,
          source: 'gmail_parser_paypal',
          status: 'matched',
          rawData: { subject, paymentData }
        }
      });

      // Marca email come letta
      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          removeLabelIds: ['UNREAD']
        }
      });

      // TODO: Invia email conferma al cliente

    } else {
      console.log('[PayPal] ⚠️ No matching order found');
      
      await prisma.paymentLog.create({
        data: {
          source: 'gmail_parser_paypal',
          status: 'unmatched',
          rawData: { subject, paymentData }
        }
      });
    }

  } catch (error) {
    console.error('[PayPal] Error processing message:', error);
  }
}

// ==================================
// PROCESS REVOLUT MESSAGE
// ==================================

async function processRevolutMessage(gmail, messageId) {
  // Simile a PayPal, adattato per formato Revolut
  // Implementazione analoga...
  console.log('[Revolut] Processing message:', messageId);
  // TODO: Implementa logica specifica Revolut
}

// ==================================
// CRON TRIGGER (ogni 3 minuti)
// ==================================

if (require.main === module) {
  // Esegui immediatamente
  checkPayments();

  // Setup cron (ogni 3 minuti)
  setInterval(() => {
    checkPayments();
  }, 3 * 60 * 1000);

  console.log('[Gmail Parser] Cron job started (interval: 3 minutes)');
}

module.exports = { checkPayments };