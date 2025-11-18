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

    // Ottieni configurazione sconti
    const bundleConfig = await prisma.config.findUnique({
      where: { key: 'bundle_discount' }
    });

    const launchActive = await prisma.config.findUnique({
      where: { key: 'launch_prices_active' }
    });

    res.json({
      products: products.map(p => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        price: launchActive?.value?.active ? p.launchPrice : p.basePrice,
        colors: p.colors,
        sizes: p.sizes
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
app.post('/api/orders', async (req, res) => {
  try {
    const { customerEmail, customerName, items, paymentMethod } = req.body;

    // Validazione base
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

    const total = subtotal - discount;

    // Crea ordine
    const order = await prisma.order.create({
      data: {
        customerEmail,
        customerName,
        subtotal,
        discount,
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
      }
    });

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

// GET analytics
app.get('/api/admin/analytics', adminAuth, async (req, res) => {
  try {
    const totalOrders = await prisma.order.count();
    const paidOrders = await prisma.order.count({ where: { paymentStatus: 'PAID' } });
    const revenue = await prisma.order.aggregate({
      where: { paymentStatus: 'PAID' },
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
      revenue: revenue._sum.total || 0,
      topProducts
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Errore nel recupero analytics' });
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
app.post('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const { name, slug, basePrice, launchPrice, colors, sizes, isActive, imageUrl } = req.body;

    // Validazione
    if (!name || !slug || !basePrice) {
      return res.status(400).json({ error: 'Dati prodotto incompleti' });
    }

    const product = await prisma.product.create({
      data: {
        name,
        slug,
        basePrice: parseFloat(basePrice),
        launchPrice: launchPrice ? parseFloat(launchPrice) : null,
        colors: colors || [],
        sizes: sizes || ['S', 'M', 'L', 'XL', 'XXL'],
        isActive: isActive !== undefined ? isActive : true,
        imageUrl: imageUrl || null
      }
    });

    res.json(product);
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ error: 'Errore nella creazione prodotto' });
  }
});

// PUT aggiorna prodotto esistente
app.put('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const { name, basePrice, launchPrice, colors, sizes, isActive, imageUrl } = req.body;

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        ...(name && { name }),
        ...(basePrice !== undefined && { basePrice: parseFloat(basePrice) }),
        ...(launchPrice !== undefined && { launchPrice: launchPrice ? parseFloat(launchPrice) : null }),
        ...(colors && { colors }),
        ...(sizes && { sizes }),
        ...(isActive !== undefined && { isActive }),
        ...(imageUrl !== undefined && { imageUrl })  // 🆕 AGGIUNGI QUESTO
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
