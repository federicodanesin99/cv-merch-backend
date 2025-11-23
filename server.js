// server.js - Backend principale MIDA Merch Store
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

// Middleware
app.use(cors());
app.use(express.json());

// ==================================
// HEALTH CHECK (per evitare sleep)
// ==================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

if (process.env.NODE_ENV === 'production') {
  const BACKEND_URL = process.env.BACKEND_URL || 'https://cv-merch-backend.onrender.com';
  
  setInterval(async () => {
    try {
      await fetch(`${BACKEND_URL}/health`);
      console.log('✅ Keep-alive ping');
    } catch (err) {
      console.error('❌ Keep-alive failed:', err);
    }
  }, 10 * 60 * 1000); // Ogni 10 minuti
}


// ==================================
// PUBLIC API - STORE
// ==================================

// GET prodotti e configurazione prezzi
app.get('/api/products', async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' }
    });

    const launchActive = await prisma.config.findUnique({
      where: { key: 'launch_prices_active' }
    });

    const bundleConfig = await prisma.config.findUnique({
      where: { key: 'bundle_discount' }
    });

    res.json({
      products: products.map(p => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description, // 🆕
        sizeGuide: p.sizeGuide, // 🆕
        basePrice: p.basePrice, // 🆕 Sempre invia basePrice
        price: launchActive?.value?.active && p.launchPrice ? p.launchPrice : p.basePrice, // Prezzo corrente
        colors: p.colors,
        sizes: p.sizes,
        images: p.images || []
      })),
      bundleDiscount: bundleConfig?.value?.percentage || 5,
      launchActive: launchActive?.value?.active || false
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Errore nel recupero prodotti' });
  }
});

// POST nuovo ordine

// GET dettaglio ordine
app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        items: {
          include: { product: true }
        }
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Ordine non trovato' });
    }

    res.json(order);
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: 'Errore nel recupero ordine' });
  }
});

// ==================================
// ADMIN API (basic auth per ora)
// ==================================
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
      res.json({ 
        token: process.env.ADMIN_TOKEN,
        success: true 
      });
    } else {
      res.status(401).json({ error: 'Credenziali non valide' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Errore durante il login' });
  }
});

// Middleware auth semplice
const adminAuth = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }
  next();
};

// GET lista ordini (admin)
app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    
    const where = status ? { paymentStatus: status } : {};
    
    const orders = await prisma.order.findMany({
      where,
      include: {
        items: {
          include: { product: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: parseInt(limit)
    });

    const total = await prisma.order.count({ where });

    res.json({
      orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Errore nel recupero ordini' });
  }
});

// PUT aggiorna stato ordine
app.put('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    const { paymentStatus, paymentId, notes } = req.body;

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: {
        paymentStatus,
        paymentId,
        notes,
        paidAt: paymentStatus === 'PAID' ? new Date() : undefined
      },
      include: {
        items: {
          include: { product: true }
        }
      }
    });

    // 🆕 Invia email se ordine confermato
    if (paymentStatus === 'PAID' && order.customerEmail) {
      try {
        await sendOrderConfirmationEmail(order);
        console.log(`✅ Email sent to ${order.customerEmail}`);
      } catch (emailError) {
        console.error('❌ Email send failed:', emailError);
        // Non bloccare la response se email fallisce
      }
    }

    res.json(order);
  } catch (error) {
    console.error('Error updating order:', error);
    res.status(500).json({ error: 'Errore nell\'aggiornamento ordine' });
  }
});

// GET configurazione
app.get('/api/admin/config', adminAuth, async (req, res) => {
  try {
    const configs = await prisma.config.findMany();
    res.json(configs);
  } catch (error) {
    console.error('Error fetching config:', error);
    res.status(500).json({ error: 'Errore nel recupero configurazione' });
  }
});

// PUT aggiorna configurazione
app.put('/api/admin/config', adminAuth, async (req, res) => {
  try {
    const { key, value } = req.body;

    const config = await prisma.config.upsert({
      where: { key },
      create: { key, value },
      update: { value }
    });

    res.json(config);
  } catch (error) {
    console.error('Error updating config:', error);
    res.status(500).json({ error: 'Errore nell\'aggiornamento configurazione' });
  }
});

// ====================================
// ADMIN API - GESTIONE PRODOTTI
// ====================================

// GET tutti i prodotti (admin view - include inattivi)
app.get('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      orderBy: { name: 'asc' }
    });
    res.json(products);
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Errore nel recupero prodotti' });
  }
});

// POST crea nuovo prodotto
app.post('/api/orders', async (req, res) => {
  try {
    const { customerEmail, customerName, customerPhone, items, paymentMethod, promoCode } = req.body;

    if (!customerEmail || !items || items.length === 0) {
      return res.status(400).json({ error: 'Dati ordine incompleti' });
    }

    // Recupera prodotti per calcolare prezzi
const productIds = [...new Set(items.map(i => i.productId))];
const products = await prisma.product.findMany({
  where: { id: { in: productIds } }
});

const productMap = Object.fromEntries(products.map(p => [p.id, p]));

// Check prezzi lancio attivi
const launchActive = await prisma.config.findUnique({
  where: { key: 'launch_prices_active' }
});
const useLaunchPrices = launchActive?.value?.active || false;

// Calcola totale e applica bundle
let subtotal = 0;
const orderItems = items.map(item => {
  const product = productMap[item.productId];
  const unitPrice = useLaunchPrices && product.launchPrice 
    ? product.launchPrice 
    : product.basePrice;
  const lineTotal = unitPrice * item.quantity;
  subtotal += lineTotal;

  return {
    productId: item.productId,
    color: item.color,
    size: item.size,
    quantity: item.quantity,
    unitPrice,
    lineTotal
  };
});

// Applica sconto bundle (2+ felpe stessa taglia)
let discount = 0;
const sizeCounts = {};
orderItems.forEach(item => {
  sizeCounts[item.size] = (sizeCounts[item.size] || 0) + item.quantity;
});

const hasBundleDiscount = Object.values(sizeCounts).some(count => count >= 2);
if (hasBundleDiscount) {
  const bundleConfig = await prisma.config.findUnique({
    where: { key: 'bundle_discount' }
  });
  const discountPercentage = bundleConfig?.value?.percentage || 5;
  discount = subtotal * (discountPercentage / 100);
}

    // Applica codice promo se presente
    let promoDiscount = 0;
    if (promoCode) {
      const promo = await prisma.promoCode.findUnique({
        where: { code: promoCode.toUpperCase().trim() }
      });

      if (promo && promo.isActive) {
        const afterBundleTotal = subtotal - discount;
        
        if (promo.discountType === 'PERCENTAGE') {
          promoDiscount = afterBundleTotal * (promo.discountValue / 100);
        } else {
          promoDiscount = promo.discountValue;
        }

        promoDiscount = Math.min(promoDiscount, afterBundleTotal);

        // Registra utilizzo
        await prisma.promoCodeUsage.create({
          data: {
            promoCodeId: promo.id,
            customerEmail
          }
        });
      }
    }

    const total = subtotal - discount - promoDiscount;

    // Crea ordine
    const order = await prisma.order.create({
      data: {
        customerEmail,
        customerName,
        customerPhone, // 🆕
        subtotal,
        discount,
        promoCode: promoCode || null, // 🆕
        promoDiscount, // 🆕
        total,
        paymentMethod: paymentMethod || 'paypal',
        items: {
          create: orderItems
        }
      },
      include: {
        items: {
          include: { product: true }
        }
      }
    });

    res.json({
      orderId: order.id,
      orderNumber: order.orderNumber,
      total: order.total,
      paymentUrl: generatePaymentUrl(order)
    });

  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Errore nella creazione dell\'ordine' });
  }
});

// POST crea nuovo prodotto - AGGIORNA
app.post('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const { name, slug, basePrice, launchPrice, colors, sizes, isActive, images, description, sizeGuide } = req.body;

    if (!name || !slug || !basePrice) {
      return res.status(400).json({ error: 'Dati prodotto incompleti' });
    }

    const product = await prisma.product.create({
      data: {
        name,
        slug,
        description: description || null,    // ✅ AGGIUNGI
        sizeGuide: sizeGuide || null,        // ✅ AGGIUNGI
        basePrice: parseFloat(basePrice),
        launchPrice: launchPrice ? parseFloat(launchPrice) : null,
        colors: colors || [],
        sizes: sizes || ['S', 'M', 'L', 'XL', 'XXL'],
        isActive: isActive !== undefined ? isActive : true,
        images: images || []
      }
    });

    res.json(product);
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ error: 'Errore nella creazione prodotto' });
  }
});

// PUT aggiorna prodotto - AGGIORNA
app.put('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const { name, basePrice, launchPrice, colors, sizes, isActive, images, description, sizeGuide } = req.body;

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description }),      // ✅ AGGIUNGI
        ...(sizeGuide !== undefined && { sizeGuide }),         // ✅ AGGIUNGI
        ...(basePrice !== undefined && { basePrice: parseFloat(basePrice) }),
        ...(launchPrice !== undefined && { launchPrice: launchPrice ? parseFloat(launchPrice) : null }),
        ...(colors && { colors }),
        ...(sizes && { sizes }),
        ...(isActive !== undefined && { isActive }),
        ...(images !== undefined && { images })
      }
    });

    res.json(product);
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ error: 'Errore nell\'aggiornamento prodotto' });
  }
});

// DELETE elimina prodotto
app.delete('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    await prisma.product.delete({
      where: { id: req.params.id }
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: 'Errore nell\'eliminazione prodotto' });
  }
});

// 🆕 DELETE cancella ordine (admin)
app.delete('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    await prisma.order.delete({
      where: { id: req.params.id }
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).json({ error: 'Errore nell\'eliminazione ordine' });
  }
});

//GET ordini con ricerca
app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;
    
    const where = {};
    
    if (status) {
      where.paymentStatus = status;
    }
    
    // 🆕 Ricerca per email o nome
    if (search) {
      where.OR = [
        { customerEmail: { contains: search, mode: 'insensitive' } },
        { customerName: { contains: search, mode: 'insensitive' } }
      ];
    }
    
    const orders = await prisma.order.findMany({
      where,
      include: {
        items: {
          include: { product: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: parseInt(limit)
    });

    const total = await prisma.order.count({ where });

    res.json({
      orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Errore nel recupero ordini' });
  }
});

// AGGIORNA Analytics per includere delivered
app.get('/api/admin/analytics', adminAuth, async (req, res) => {
  try {
    const totalOrders = await prisma.order.count();
    const paidOrders = await prisma.order.count({ where: { paymentStatus: 'PAID' } });
    const deliveredOrders = await prisma.order.count({ where: { paymentStatus: 'DELIVERED' } });
    
    const revenue = await prisma.order.aggregate({
      where: { 
        paymentStatus: { in: ['PAID', 'DELIVERED'] }
      },
      _sum: { total: true }
    });

    const topProducts = await prisma.orderItem.groupBy({
      by: ['productId'],
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 5
    });

    res.json({
      totalOrders,
      paidOrders,
      deliveredOrders, // 🆕
      revenue: revenue._sum.total || 0,
      topProducts
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Errore nel recupero analytics' });
  }
});

// POST Valida codice promozionale
app.post('/api/validate-promo', async (req, res) => {
  try {
    const { code, customerEmail, subtotal } = req.body;

    if (!code || !customerEmail || !subtotal) {
      return res.status(400).json({ error: 'Dati mancanti' });
    }

    // Cerca codice
    const promoCode = await prisma.promoCode.findUnique({
      where: { code: code.toUpperCase().trim() },
      include: {
        usedBy: {
          where: { customerEmail }
        }
      }
    });

    // Validazioni
    if (!promoCode) {
      return res.status(404).json({ error: 'Codice non valido' });
    }

    if (!promoCode.isActive) {
      return res.status(400).json({ error: 'Codice non più attivo' });
    }

    if (promoCode.expiresAt && new Date(promoCode.expiresAt) < new Date()) {
      return res.status(400).json({ error: 'Codice scaduto' });
    }

    // Check se già usato da questa email
    if (promoCode.usedBy.length >= promoCode.maxUsesPerUser) {
      return res.status(400).json({ error: 'Codice già utilizzato' });
    }

    // Check se è limitato a email specifiche
    if (promoCode.allowedEmails && promoCode.allowedEmails.length > 0) {
      const isAllowed = promoCode.allowedEmails.some(
        allowedEmail => allowedEmail.toLowerCase() === email.toLowerCase()
      );
      
      if (!isAllowed) {
        return res.status(400).json({ error: 'Codice non valido per questo utente' });
      }
    }

    // Calcola sconto
    let discount = 0;
    if (promoCode.discountType === 'PERCENTAGE') {
      discount = subtotal * (promoCode.discountValue / 100);
    } else {
      discount = promoCode.discountValue;
    }

    // Non può superare il subtotal
    discount = Math.min(discount, subtotal);

    res.json({
      valid: true,
      code: promoCode.code,
      discountType: promoCode.discountType,
      discountValue: promoCode.discountValue,
      discount: parseFloat(discount.toFixed(2)),
      message: promoCode.discountType === 'PERCENTAGE' 
        ? `Sconto ${promoCode.discountValue}% applicato!`
        : `Sconto €${promoCode.discountValue} applicato!`
    });

  } catch (error) {
    console.error('Error validating promo:', error);
    res.status(500).json({ error: 'Errore nella validazione' });
  }
});

// ADMIN - CRUD Promo Codes
app.get('/api/admin/promo-codes', adminAuth, async (req, res) => {
  try {
    const codes = await prisma.promoCode.findMany({
      include: {
        _count: {
          select: { usedBy: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(codes);
  } catch (error) {
    console.error('Error fetching promo codes:', error);
    res.status(500).json({ error: 'Errore nel recupero codici' });
  }
});

app.post('/api/admin/promo-codes', adminAuth, async (req, res) => {
  try {
    const { code, discountType, discountValue, expiresAt, maxUsesPerUser, isActive } = req.body;

    if (!code || !discountType || discountValue === undefined) {
      return res.status(400).json({ error: 'Dati incompleti' });
    }

    const promoCode = await prisma.promoCode.create({
      data: {
        code: code.toUpperCase().trim(),
        discountType,
        discountValue: parseFloat(discountValue),
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        maxUsesPerUser: maxUsesPerUser || 1,
        isActive: isActive !== undefined ? isActive : true
      }
    });

    res.json(promoCode);
  } catch (error) {
    console.error('Error creating promo code:', error);
    if (error.code === 'P2002') {
      res.status(400).json({ error: 'Codice già esistente' });
    } else {
      res.status(500).json({ error: 'Errore nella creazione' });
    }
  }
});

app.put('/api/admin/promo-codes/:id', adminAuth, async (req, res) => {
  try {
    const { discountValue, expiresAt, maxUsesPerUser, isActive } = req.body;

    const promoCode = await prisma.promoCode.update({
      where: { id: req.params.id },
      data: {
        ...(discountValue !== undefined && { discountValue: parseFloat(discountValue) }),
        ...(expiresAt !== undefined && { expiresAt: expiresAt ? new Date(expiresAt) : null }),
        ...(maxUsesPerUser !== undefined && { maxUsesPerUser }),
        ...(isActive !== undefined && { isActive })
      }
    });

    res.json(promoCode);
  } catch (error) {
    console.error('Error updating promo code:', error);
    res.status(500).json({ error: 'Errore nell\'aggiornamento' });
  }
});

app.delete('/api/admin/promo-codes/:id', adminAuth, async (req, res) => {
  try {
    await prisma.promoCode.delete({
      where: { id: req.params.id }
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting promo code:', error);
    res.status(500).json({ error: 'Errore nell\'eliminazione' });
  }
});

// Al posto di nodemailer, usa Resend
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendOrderConfirmationEmail(order) {
  try {
    const itemsList = order.items.map(item => 
      `${item.quantity}x ${item.product.name} - ${item.color} (${item.size}) = €${item.lineTotal.toFixed(2)}`
    ).join('\n');

    await resend.emails.send({
      from: 'CLASSE VENETA <noreply@classeveneta.com>',
      to: order.customerEmail,
      subject: `Ordine #${order.orderNumber.toString().padStart(4, '0')} Confermato`,
      html: `
        <h2>Ordine Confermato! 🎉</h2>
        <p>Ciao ${order.customerName},</p>
        <p>Il tuo ordine <strong>#${order.orderNumber.toString().padStart(4, '0')}</strong> è stato confermato!</p>
        
        <h3>Dettagli:</h3>
        <pre>${itemsList}</pre>
        
        <p><strong>Subtotale:</strong> €${order.subtotal.toFixed(2)}</p>
        ${order.discount > 0 ? `<p><strong>Sconto Bundle:</strong> -€${order.discount.toFixed(2)}</p>` : ''}
        ${order.promoDiscount > 0 ? `<p><strong>Codice Promo (${order.promoCode}):</strong> -€${order.promoDiscount.toFixed(2)}</p>` : ''}
        <p><strong>TOTALE:</strong> €${order.total.toFixed(2)}</p>
        
        <p>Riceverai la tua felpa entro 3 settimane!</p>
        <p>Grazie per il tuo ordine,<br>CLASSE VENETA</p>
      `
    });
    
    console.log(`✅ Email sent to ${order.customerEmail}`);
  } catch (error) {
    console.error('❌ Email failed:', error);
    throw error;
  }
}

// ==================================
// HELPERS
// ==================================

function generatePaymentUrl(order) {
  const amount = order.total.toFixed(2);
  const orderId = order.orderNumber.toString().padStart(4, '0');
  const note = `Ordine MIDA #${orderId}`;

  if (order.paymentMethod === 'paypal') {
    // Sostituisci con il tuo username PayPal
    return `https://paypal.me/${process.env.PAYPAL_USER}/${amount}EUR?note=${encodeURIComponent(note)}`;
  } else {
    // Revolut Pay link (da configurare)
    return `https://revolut.me/${process.env.REVOLUT_USER}`;
  }
}

// ==================================
// START SERVER
// ==================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 MIDA Merch Backend running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server...');
  await prisma.$disconnect();
  process.exit(0);
});
