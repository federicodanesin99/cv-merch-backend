// gmail-parser-oauth.js - Gmail Parser con OAuth 2.0 per account personali
const { google } = require('googleapis');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');

const prisma = new PrismaClient();

// ==================================
// CONFIGURAZIONE OAUTH
// ==================================

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = process.env.NODE_ENV === 'production'
  ? '/etc/secrets/gmail-token.json'
  : path.join(__dirname, 'gmail-token.json');

const CREDENTIALS_PATH = process.env.NODE_ENV === 'production'
  ? '/etc/secrets/gmail-credentials.json'
  : path.join(__dirname, 'gmail-credentials.json');

// ==================================
// AUTENTICAZIONE OAUTH
// ==================================

async function getGmailClient() {
  try {
    // Carica credentials OAuth
    const credentials = JSON.parse(
      await fs.readFile(CREDENTIALS_PATH, 'utf8')
    );

    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0]
    );

    // Prova a caricare token salvato
    try {
      const token = JSON.parse(await fs.readFile(TOKEN_PATH, 'utf8'));
      oAuth2Client.setCredentials(token);
      
      // Verifica se token è scaduto e rinnovalo
      if (oAuth2Client.isTokenExpiring()) {
        console.log('[OAuth] Token expiring, refreshing...');
        const { credentials } = await oAuth2Client.refreshAccessToken();
        oAuth2Client.setCredentials(credentials);
        await fs.writeFile(TOKEN_PATH, JSON.stringify(credentials));
      }
    } catch (err) {
      // Token non esiste, avvia primo auth
      console.log('[OAuth] No valid token found, starting authorization...');
      await getNewToken(oAuth2Client);
    }

    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    return gmail;
  } catch (error) {
    console.error('[OAuth] Error loading credentials:', error);
    throw new Error('Credenziali OAuth non trovate. Scarica gmail-credentials.json da Google Cloud Console.');
  }
}

// Primo auth: genera URL e salva token
async function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('\n🔐 AUTENTICAZIONE RICHIESTA');
  console.log('=====================================');
  console.log('Apri questo link nel browser:\n');
  console.log(authUrl);
  console.log('\n=====================================');
  console.log('Dopo aver autorizzato, copia il codice qui sotto:\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve, reject) => {
    rl.question('Codice di autorizzazione: ', async (code) => {
      rl.close();
      try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens));
        console.log('✅ Token salvato in:', TOKEN_PATH);
        resolve();
      } catch (err) {
        console.error('❌ Errore nel recupero token:', err);
        reject(err);
      }
    });
  });
}

// ==================================
// PARSING EMAIL PAYPAL
// ==================================

function parsePayPalEmail(subject, body) {
  const amountMatch = body.match(/(\d+[,\.]\d{2})\s*(EUR|€)/i);
  const emailMatch = body.match(/[\w\.-]+@[\w\.-]+\.\w+/g);
  const transactionMatch = body.match(/(?:Numero transazione|Transaction ID|Codice transazione):\s*([A-Z0-9]+)/i);
  const orderMatch = body.match(/(?:Ordine|Order|MIDA)\s*#?(\d{4})/i);
  const nameMatch = body.match(/Messaggio da\s+([^<]+)</i);
  const uniqueCodeMatch = body.match(/CLA\$\$EV€N€TA-\d{4}-[A-Z0-9]{4}/i);


  return {
    amount: amountMatch ? parseFloat(amountMatch[1].replace(',', '.')) : null,
    customerEmail: emailMatch?.[0],
    transactionId: transactionMatch?.[1],
    orderNumber: orderMatch ? parseInt(orderMatch[1]) : null,
    customerName: nameMatch?.[1],
    uniqueCode: uniqueCodeMatch?.[0] 
  };
}

// ==================================
// PARSING EMAIL REVOLUT
// ==================================

function parseRevolutEmail(subject, body) {
  const amountMatch = body.match(/€?\s*(\d+[,\.]\d{2})/);
  const emailMatch = body.match(/[\w\.-]+@[\w\.-]+\.\w+/g);
  const referenceMatch = body.match(/(?:Reference|Riferimento|Note):\s*(.+?)(?:\n|$)/i);
  const orderMatch = body.match(/(?:Ordine|Order|MIDA)\s*#?(\d{4})/i);

  return {
    amount: amountMatch ? parseFloat(amountMatch[1].replace(',', '.')) : null,
    customerEmail: emailMatch?.[0],
    reference: referenceMatch?.[1]?.trim(),
    orderNumber: orderMatch ? parseInt(orderMatch[1]) : null
  };
}

// ==================================
// HELPER: Estrai Nome e Cognome
// ==================================

function splitName(fullName) {
    if (!fullName) return { firstName: null, lastName: null };
    
    // Pulisci il nome
    const cleaned = fullName.trim().replace(/\s+/g, ' ');
    
    // Split per spazio
    const parts = cleaned.split(' ');
    
    if (parts.length === 0) return { firstName: null, lastName: null };
    if (parts.length === 1) return { firstName: parts[0], lastName: null };
    
    // Se ci sono 2+ parti, prendi prima parola come nome, resto come cognome
    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ');
    
    return { firstName, lastName };
  }

// ==================================
// MATCH ORDINE NEL DATABASE
// ==================================

async function matchOrderWithPayment(paymentData) {
    console.log('[Match] Searching order for:', paymentData);
  
  // 🆕 Strategia 0: Match per uniqueCode (massima priorità!)
  if (paymentData.uniqueCode) {
    const order = await prisma.order.findFirst({
      where: {
        uniqueCode: paymentData.uniqueCode,
        paymentStatus: 'PENDING',
        total: {
              gte: paymentData.amount - 0.5,
              lte: paymentData.amount + 0.5
            }, 
      }
    });
    if (order) {
      console.log('[Match] ✅ Found by unique code (BEST!)');
      return order;
    }
  }

    // Strategia 1: Match per orderNumber
    if (paymentData.orderNumber) {
      const order = await prisma.order.findFirst({
        where: {
          orderNumber: paymentData.orderNumber,
          paymentStatus: 'PENDING',
          total: paymentData.amount
        }
      });
      if (order) {
        console.log('[Match] ✅ Found by order number');
        return order;
      }
    }
  
    // Strategia 2: Match per email + importo (ultimi 7 giorni)
    if (paymentData.customerEmail && paymentData.amount) {
      const order = await prisma.order.findFirst({
        where: {
          customerEmail: paymentData.customerEmail,
          total: {
            gte: paymentData.amount - 0.5,
            lte: paymentData.amount + 0.5
          },
          paymentStatus: 'PENDING',
          createdAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          }
        },
        orderBy: { createdAt: 'desc' }
      });
      
      if (order) {
        console.log('[Match] ✅ Found by email + amount');
        return order;
      }
    }
  
    // 🆕 Strategia 3: Match per nome + importo (ultimi 3 giorni)
    if (paymentData.customerName && paymentData.amount) {
      const { firstName, lastName } = splitName(paymentData.customerName);
      
      if (firstName && lastName) {
        console.log(`[Match] Trying name match: "${firstName} ${lastName}"`);
        
        // Prova 1: Nome Cognome (es. "Mario Rossi")
        let order = await prisma.order.findFirst({
          where: {
            customerName: {
              contains: `${firstName} ${lastName}`,
              mode: 'insensitive'
            },
/*             total: {
              gte: paymentData.amount - 0.5,
              lte: paymentData.amount + 0.5
            }, */
            paymentStatus: 'PENDING',
            createdAt: {
              gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) // Ultimi 3 giorni
            }
          },
          orderBy: { createdAt: 'desc' }
        });
        
        if (order) {
          console.log('[Match] ✅ Found by name (normal order)');
          return order;
        }
        
        // Prova 2: Cognome Nome invertito (es. "Rossi Mario")
        console.log(`[Match] Trying reversed: "${lastName} ${firstName}"`);
        order = await prisma.order.findFirst({
          where: {
            customerName: {
              contains: `${lastName} ${firstName}`,
              mode: 'insensitive'
            },
            total: {
              gte: paymentData.amount - 0.5,
              lte: paymentData.amount + 0.5
            },
            paymentStatus: 'PENDING',
            createdAt: {
              gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
            }
          },
          orderBy: { createdAt: 'desc' }
        });
        
        if (order) {
          console.log('[Match] ✅ Found by name (reversed order)');
          return order;
        }
        
        // Prova 3: Solo cognome (più permissivo)
        console.log(`[Match] Trying last name only: "${lastName}"`);
        order = await prisma.order.findFirst({
          where: {
            customerName: {
              contains: lastName,
              mode: 'insensitive'
            },
            total: {
              gte: paymentData.amount - 0.3, // Tolleranza più stretta
              lte: paymentData.amount + 0.3
            },
            paymentStatus: 'PENDING',
            createdAt: {
              gte: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) // Solo ultimi 2 giorni
            }
          },
          orderBy: { createdAt: 'desc' }
        });
        
        if (order) {
          console.log('[Match] ⚠️ Found by last name only (verify!)');
          return order;
        }
      }
    }
  
    // Strategia 4: Solo importo (ultimi 2 giorni)
    if (paymentData.amount) {
      const order = await prisma.order.findFirst({
        where: {
          total: {
            gte: paymentData.amount - 0.1,
            lte: paymentData.amount + 0.1
          },
          paymentStatus: 'PENDING',
          createdAt: {
            gte: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
          }
        },
        orderBy: { createdAt: 'desc' }
      });
      
      if (order) {
        console.log('[Match] ⚠️ Found by amount only (verify!)');
        return order;
      }
    }
  
    console.log('[Match] ❌ No matching order found');
    return null;
  }

// ==================================
// MAIN PARSER FUNCTION
// ==================================

async function checkPayments() {
  console.log('\n[Gmail Parser] Starting payment check...');
  console.log('Time:', new Date().toISOString());

  try {
    const gmail = await getGmailClient();

    // Query per email PayPal non lette
    const paypalQuery = 'from:(assistenza@paypal.it OR service@paypal.com) subject:"Hai ricevuto denaro"';
    const paypalRes = await gmail.users.messages.list({
      userId: 'me',
      q: paypalQuery,
      maxResults: 10
    });

    // Query per email Revolut non lette
    const revolutQuery = 'from:no-reply@revolut.com subject:received is:unread';
    const revolutRes = await gmail.users.messages.list({
      userId: 'me',
      q: revolutQuery,
      maxResults: 10
    });

    const paypalMessages = paypalRes.data.messages || [];
    const revolutMessages = revolutRes.data.messages || [];

    console.log(`[Gmail Parser] Found ${paypalMessages.length} PayPal + ${revolutMessages.length} Revolut emails`);

    let processed = 0;
    let matched = 0;

    // Processa PayPal
    for (const message of paypalMessages) {
      const result = await processPayPalMessage(gmail, message.id);
      processed++;
      if (result) matched++;
    }

    // Processa Revolut
    for (const message of revolutMessages) {
      const result = await processRevolutMessage(gmail, message.id);
      processed++;
      if (result) matched++;
    }

    console.log(`[Gmail Parser] ✅ Completed: ${processed} processed, ${matched} matched\n`);

  } catch (error) {
    console.error('[Gmail Parser] ❌ Error:', error.message);
    
    // Log errore nel database
    try {
      await prisma.paymentLog.create({
        data: {
          source: 'gmail_parser',
          status: 'error',
          rawData: { error: error.message, stack: error.stack }
        }
      });
    } catch (dbError) {
      console.error('[Gmail Parser] Failed to log error:', dbError);
    }
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
    const date = headers.find(h => h.name === 'Date')?.value || '';
    
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

    console.log('\n[PayPal] Processing email:', subject);
    console.log('[PayPal] Date:', date);

    // Parsing
    //console.log('[PayPal] BODY:', body);
    const paymentData = parsePayPalEmail(subject, body);
    console.log('[PayPal] Parsed data:', paymentData);

    // Match ordine
    const order = await matchOrderWithPayment(paymentData);

    if (order) {
      // Aggiorna ordine
      await prisma.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: 'PAID',
          paymentId: paymentData.transactionId || `PAYPAL-${Date.now()}`,
          paidAt: new Date(),
          notes: order.notes 
            ? `${order.notes}\n\nPagamento confermato automaticamente via Gmail Parser`
            : 'Pagamento confermato automaticamente via Gmail Parser'
        }
      });

      console.log(`[PayPal] ✅ Order #${order.orderNumber} marked as PAID`);

      // Log successo
      await prisma.paymentLog.create({
        data: {
          orderId: order.id,
          source: 'gmail_parser_paypal',
          status: 'matched',
          rawData: { subject, date, paymentData }
        }
      });

      // Marca email come letta
/*       await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          removeLabelIds: ['UNREAD']
        }
      });
 */
      return true;

    } else {
      console.log('[PayPal] ⚠️ No matching order found');
      
      await prisma.paymentLog.create({
        data: {
          source: 'gmail_parser_paypal',
          status: 'unmatched',
          rawData: { subject, date, paymentData, body: body.substring(0, 500) }
        }
      });

      return false;
    }

  } catch (error) {
    console.error('[PayPal] ❌ Error processing message:', error.message);
    return false;
  }
}

// ==================================
// PROCESS REVOLUT MESSAGE
// ==================================

async function processRevolutMessage(gmail, messageId) {
  try {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    const headers = msg.data.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const date = headers.find(h => h.name === 'Date')?.value || '';
    
    let body = '';
    if (msg.data.payload.parts) {
      const textPart = msg.data.payload.parts.find(p => p.mimeType === 'text/plain');
      if (textPart?.body?.data) {
        body = Buffer.from(textPart.body.data, 'base64').toString();
      }
    } else if (msg.data.payload.body?.data) {
      body = Buffer.from(msg.data.payload.body.data, 'base64').toString();
    }

    console.log('\n[Revolut] Processing email:', subject);

    const paymentData = parseRevolutEmail(subject, body);
    console.log('[Revolut] Parsed data:', paymentData);

    const order = await matchOrderWithPayment(paymentData);

    if (order) {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: 'PAID',
          paymentId: paymentData.reference || `REVOLUT-${Date.now()}`,
          paidAt: new Date(),
          notes: order.notes 
            ? `${order.notes}\n\nPagamento confermato automaticamente via Gmail Parser`
            : 'Pagamento confermato automaticamente via Gmail Parser'
        }
      });

      console.log(`[Revolut] ✅ Order #${order.orderNumber} marked as PAID`);

      await prisma.paymentLog.create({
        data: {
          orderId: order.id,
          source: 'gmail_parser_revolut',
          status: 'matched',
          rawData: { subject, date, paymentData }
        }
      });

      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          removeLabelIds: ['UNREAD']
        }
      });

      return true;
    } else {
      console.log('[Revolut] ⚠️ No matching order found');
      
      await prisma.paymentLog.create({
        data: {
          source: 'gmail_parser_revolut',
          status: 'unmatched',
          rawData: { subject, date, paymentData, body: body.substring(0, 500) }
        }
      });

      return false;
    }

  } catch (error) {
    console.error('[Revolut] ❌ Error processing message:', error.message);
    return false;
  }
}

// ==================================
// CRON TRIGGER
// ==================================

if (require.main === module) {
  // Test mode: esegui una volta
  if (process.argv.includes('--once')) {
    console.log('🧪 Running in TEST mode (single execution)');
    checkPayments()
      .then(() => {
        console.log('✅ Test completed');
        process.exit(0);
      })
      .catch((err) => {
        console.error('❌ Test failed:', err);
        process.exit(1);
      });
  } else {
    // Production mode: cron ogni 5 minuti
    console.log('🚀 Gmail Parser started in CRON mode');
    console.log('⏱️  Interval: 5 minutes');
    
    // Prima esecuzione
    checkPayments();

    // Setup cron
    setInterval(() => {
      checkPayments();
    }, 5 * 60 * 1000);
  }
}

module.exports = { checkPayments, getGmailClient };