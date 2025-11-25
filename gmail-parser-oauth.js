// gmail-parser-oauth.js - Gmail Parser con OAuth 2.0 e storage DB
const { google } = require('googleapis');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');

const prisma = new PrismaClient();

// ==================================
// CONFIGURAZIONE
// ==================================
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const CREDENTIALS_PATH = path.join(__dirname, 'gmail-credentials.json');

// Verifica configurazione critica
if (!ADMIN_TOKEN) {
  console.warn('⚠️ ADMIN_TOKEN non configurato. Le chiamate API falliranno in produzione.');
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ ADMIN_TOKEN è obbligatorio in produzione!');
    process.exit(1);
  }
}

// ==================================
// DATABASE TOKEN MANAGEMENT
// ==================================

async function loadTokenFromDB() {
  try {
    const tokenRecord = await prisma.oAuthToken.findUnique({
      where: { provider: 'gmail' }
    });
    
    if (!tokenRecord) {
      console.log('[OAuth DB] No token found');
      return null;
    }
    
    console.log('[OAuth DB] Token loaded successfully');
    return {
      access_token: tokenRecord.accessToken,
      refresh_token: tokenRecord.refreshToken,
      scope: tokenRecord.scope,
      token_type: tokenRecord.tokenType,
      expiry_date: tokenRecord.expiryDate ? Number(tokenRecord.expiryDate) : null
    };
  } catch (error) {
    console.error('[OAuth DB] Error loading token:', error.message);
    return null;
  }
}

async function saveTokenToDB(token) {
  try {
    await prisma.oAuthToken.upsert({
      where: { provider: 'gmail' },
      create: {
        provider: 'gmail',
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        scope: token.scope || null,
        tokenType: token.token_type || 'Bearer',
        expiryDate: token.expiry_date ? BigInt(token.expiry_date) : null
      },
      update: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiryDate: token.expiry_date ? BigInt(token.expiry_date) : null
      }
    });
    
    console.log('[OAuth DB] ✅ Token saved successfully');
    return true;
  } catch (error) {
    console.error('[OAuth DB] ❌ Error saving token:', error.message);
    return false;
  }
}

// ==================================
// OAUTH CLIENT SETUP
// ==================================

async function getGmailClient() {
  try {
    // 1. Carica credentials (da env var o file)
    let credentials;
    if (process.env.GMAIL_CREDENTIALS) {
      console.log('[OAuth] Loading credentials from environment');
      credentials = JSON.parse(process.env.GMAIL_CREDENTIALS);
    } else {
      console.log('[OAuth] Loading credentials from file');
      credentials = JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf8'));
    }

    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0]
    );

    // 2. Carica token dal database
    let token = await loadTokenFromDB();
    
    if (!token) {
      console.log('[OAuth] No token available');
      
      // In produzione, non possiamo fare auth interattivo
      if (process.env.NODE_ENV === 'production') {
        throw new Error('❌ No token found in database. Run initial authentication in local environment first.');
      }
      
      // In locale, fai auth interattivo
      console.log('[OAuth] Starting interactive authentication...');
      token = await getNewToken(oAuth2Client);
      await saveTokenToDB(token);
    }
    
    oAuth2Client.setCredentials(token);
    
    // 3. Controlla se il token sta per scadere
    const now = Date.now();
    const expiresIn = token.expiry_date ? token.expiry_date - now : 0;
    const hoursLeft = Math.round(expiresIn / 1000 / 60 / 60);
    
    if (expiresIn > 0) {
      console.log(`[OAuth] Token valid for ${hoursLeft} hours`);
    }
    
    // Refresh se scade entro 1 ora
    if (token.expiry_date && expiresIn < 60 * 60 * 1000) {
      console.log('[OAuth] Token expiring soon, refreshing...');
      
      try {
        const { credentials: newToken } = await oAuth2Client.refreshAccessToken();
        oAuth2Client.setCredentials(newToken);
        
        // Salva il nuovo token nel database
        await saveTokenToDB(newToken);
        console.log('[OAuth] ✅ Token refreshed and saved to database');
        
      } catch (refreshError) {
        console.error('[OAuth] ❌ Token refresh failed:', refreshError.message);
        
        // In locale, prova a rifare l'auth completo
        if (process.env.NODE_ENV !== 'production') {
          console.log('[OAuth] Attempting re-authentication...');
          const newToken = await getNewToken(oAuth2Client);
          await saveTokenToDB(newToken);
          oAuth2Client.setCredentials(newToken);
        } else {
          throw new Error('Token refresh failed in production. Manual intervention required.');
        }
      }
    }

    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    return gmail;
    
  } catch (error) {
    console.error('[OAuth] Fatal error:', error.message);
    throw error;
  }
}

// ==================================
// INTERACTIVE AUTH (LOCAL ONLY)
// ==================================

async function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // Forza nuovo refresh_token
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
        console.log('✅ Token ottenuto con successo');
        resolve(tokens);
      } catch (err) {
        console.error('❌ Errore nel recupero token:', err.message);
        reject(err);
      }
    });
  });
}

// ==================================
// CONNECTION TEST
// ==================================

async function testGmailConnection() {
  try {
    const gmail = await getGmailClient();
    const profile = await gmail.users.getProfile({ userId: 'me' });
    console.log('[Gmail] ✅ Connection successful:', profile.data.emailAddress);
    return true;
  } catch (error) {
    console.error('[Gmail] ❌ Connection test failed:', error.message);
    return false;
  }
}

// ==================================
// EMAIL PARSING FUNCTIONS
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

function parseRevolutEmail(subject, body) {
  const amountMatch = body.match(/€?\s*(\d+[,\.]\d{2})/);
  const emailMatch = body.match(/[\w\.-]+@[\w\.-]+\.\w+/g);
  const referenceMatch = body.match(/(?:Reference|Riferimento|Note):\s*(.+?)(?:\n|$)/i);
  const orderMatch = body.match(/(?:Ordine|Order|MIDA)\s*#?(\d{4})/i);
  const uniqueCodeMatch = body.match(/CLA\$\$EVÈ›NÈ›TA-\d{4}-[A-Z0-9]{4}/i);

  return {
    amount: amountMatch ? parseFloat(amountMatch[1].replace(',', '.')) : null,
    customerEmail: emailMatch?.[0],
    reference: referenceMatch?.[1]?.trim(),
    orderNumber: orderMatch ? parseInt(orderMatch[1]) : null,
    uniqueCode: uniqueCodeMatch?.[0]
  };
}

// ==================================
// NAME PARSING
// ==================================

function splitName(fullName) {
  if (!fullName) return { firstName: null, lastName: null };
  
  const cleaned = fullName.trim().replace(/\s+/g, ' ');
  const parts = cleaned.split(' ');
  
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ');
  
  return { firstName, lastName };
}

// ==================================
// ORDER MATCHING
// ==================================

async function matchOrderWithPayment(paymentData) {
  console.log('[Match] Searching order for:', {
    uniqueCode: paymentData.uniqueCode,
    orderNumber: paymentData.orderNumber,
    amount: paymentData.amount,
    email: paymentData.customerEmail,
    name: paymentData.customerName
  });

  // Strategia 1: Match per uniqueCode (massima priorità!)
  if (paymentData.uniqueCode) {
    const order = await prisma.order.findFirst({
      where: {
        uniqueCode: paymentData.uniqueCode,
        paymentStatus: 'PENDING',
        total: {
          gte: paymentData.amount - 0.5,
          lte: paymentData.amount + 0.5
        }
      }
    });
    if (order) {
      console.log('[Match] ✅ Found by unique code');
      return order;
    }
  }

 /*  // Strategia 2: Match per orderNumber
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

  // Strategia 3: Match per email + importo
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

  // Strategia 4: Match per nome + importo
  if (paymentData.customerName && paymentData.amount) {
    const { firstName, lastName } = splitName(paymentData.customerName);
    
    if (firstName && lastName) {
      console.log(`[Match] Trying name match: "${firstName} ${lastName}"`);
      
      const order = await prisma.order.findFirst({
        where: {
          OR: [
            { customerName: { contains: `${firstName} ${lastName}`, mode: 'insensitive' } },
            { customerName: { contains: `${lastName} ${firstName}`, mode: 'insensitive' } },
            { customerName: { contains: lastName, mode: 'insensitive' } }
          ],
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
        console.log('[Match] ✅ Found by name');
        return order;
      }
    }
  }

  // Strategia 5: Solo importo
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
  } */

  console.log('[Match] ❌ No matching order found');
  return null;
}

// ==================================
// API UPDATE HELPER
// ==================================

async function updateOrderViaAPI(orderId, updateData) {
  try {
    console.log(`[API] Updating order ${orderId} via backend API...`);
    
    const response = await fetch(`${BACKEND_URL}/api/admin/orders/${orderId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updateData)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    const result = await response.json();
    console.log('[API] ✅ Order updated successfully');
    return result;
  } catch (error) {
    console.error('[API] ❌ Error updating order:', error.message);
    
    // Log più dettagliato per troubleshooting
    if (error.message.includes('401')) {
      console.error('[API] 💡 Verifica che ADMIN_TOKEN sia corretto');
    } else if (error.message.includes('fetch')) {
      console.error('[API] 💡 Verifica che BACKEND_URL sia raggiungibile:', BACKEND_URL);
    }
    
    throw error;
  }
}

// ==================================
// EMAIL PROCESSING
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

    const paymentData = parsePayPalEmail(subject, body);
    console.log('[PayPal] Parsed data:', paymentData);

    const order = await matchOrderWithPayment(paymentData);

    if (order) {
      try {
        // 🆕 Aggiorna tramite API (così invia anche l'email di conferma)
        await updateOrderViaAPI(order.id, {
          paymentStatus: 'PAID',
          paymentId: paymentData.transactionId || `PAYPAL-${Date.now()}`,
          notes: order.notes 
            ? `${order.notes}\n\nPagamento confermato automaticamente via Gmail Parser`
            : 'Pagamento confermato automaticamente via Gmail Parser'
        });
        
        console.log(`[PayPal] ✅ Order #${order.orderNumber} marked as PAID (email sent via API)`);

        // Log successo nel database
        await prisma.paymentLog.create({
          data: {
            orderId: order.id,
            source: 'gmail_parser_paypal',
            status: 'matched',
            rawData: { subject, date, paymentData }
          }
        });
        
        return true;
      } catch (apiError) {
        console.error('[PayPal] ❌ API call failed:', apiError.message);
        
        // Log fallimento
        await prisma.paymentLog.create({
          data: {
            orderId: order.id,
            source: 'gmail_parser_paypal',
            status: 'matched_but_update_failed',
            rawData: { subject, date, paymentData, error: apiError.message }
          }
        });
        
        return false;
      }
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
      try {
        // 🆕 Aggiorna tramite API (così invia anche l'email di conferma)
        await updateOrderViaAPI(order.id, {
          paymentStatus: 'PAID',
          paymentId: paymentData.reference || `REVOLUT-${Date.now()}`,
          notes: order.notes 
            ? `${order.notes}\n\nPagamento confermato automaticamente via Gmail Parser`
            : 'Pagamento confermato automaticamente via Gmail Parser'
        });

        console.log(`[Revolut] ✅ Order #${order.orderNumber} marked as PAID (email sent via API)`);

        // Log successo nel database
        await prisma.paymentLog.create({
          data: {
            orderId: order.id,
            source: 'gmail_parser_revolut',
            status: 'matched',
            rawData: { subject, date, paymentData }
          }
        });

        return true;
      } catch (apiError) {
        console.error('[Revolut] ❌ API call failed:', apiError.message);
        
        // Log fallimento
        await prisma.paymentLog.create({
          data: {
            orderId: order.id,
            source: 'gmail_parser_revolut',
            status: 'matched_but_update_failed',
            rawData: { subject, date, paymentData, error: apiError.message }
          }
        });
        
        return false;
      }
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
// MAIN CHECK FUNCTION
// ==================================

async function checkPayments() {
  console.log('\n[Gmail Parser] Starting payment check...');
  console.log('Time:', new Date().toISOString());

  try {
    const gmail = await getGmailClient();

    // Query email PayPal
    const paypalQuery = 'from:(assistenza@paypal.it OR service@paypal.com) subject:"Hai ricevuto denaro"';
    const paypalRes = await gmail.users.messages.list({
      userId: 'me',
      q: paypalQuery,
      maxResults: 5
    });

    // Query email Revolut
    const revolutQuery = 'from:no-reply@revolut.com subject:received';
    const revolutRes = await gmail.users.messages.list({
      userId: 'me',
      q: revolutQuery,
      maxResults: 5
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
    
    try {
      await prisma.paymentLog.create({
        data: {
          source: 'gmail_parser',
          status: 'error',
          rawData: { error: error.message, stack: error.stack }
        }
      });
    } catch (dbError) {
      console.error('[Gmail Parser] Failed to log error:', dbError.message);
    }
  }
}

// ==================================
// STARTUP & CRON
// ==================================

if (require.main === module) {
  console.log('🚀 Gmail Parser starting...');
  console.log('Environment:', process.env.NODE_ENV || 'development');
  console.log('Backend URL:', BACKEND_URL);
  console.log('Admin Token:', ADMIN_TOKEN ? '✅ Configured' : '❌ Missing');
  
  // Test connessione all'avvio
  testGmailConnection().then(ok => {
    if (!ok) {
      console.error('❌ Gmail connection test failed. Check OAuth setup.');
      
      if (process.env.NODE_ENV === 'production') {
        process.exit(1);
      }
    }
    
    // Modalità test (esecuzione singola)
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
      // Modalità produzione (cron ogni 5 minuti)
      console.log('⏱️ Running in CRON mode (every 5 minutes)');
      
      // Prima esecuzione immediata
      checkPayments();

      // Setup cron
      setInterval(() => {
        checkPayments();
      }, 5 * 60 * 1000);
    }
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing connections...');
  await prisma.$disconnect();
  process.exit(0);
});

module.exports = { checkPayments, getGmailClient, testGmailConnection };