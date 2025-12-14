// server.js - Backend principale MIDA Merch Store
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

// Middleware
// Middleware CORS configurato per dev e production
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://classe-veneta-admin.vercel.app', 'https://cv-merch-frontend.vercel.app', 'https://admin-panel-cluuxuxpb-classe-venetas-projects.vercel.app', 'https://admin-panel-ashy-two.vercel.app'] // I tuoi domini production
    : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3001'], // Dev locale
  credentials: true
}));
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

    // Config per mostrare/nascondere promo
    const promoVisibleConfig = await prisma.config.findUnique({
      where: { key: 'promo_codes_visible' }
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
      launchActive: launchActive?.value?.active || false,
      promoCodesVisible: promoVisibleConfig?.value?.visible !== false  // Default true
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
    const { status, page = 1, limit = 1000 } = req.query;
    
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

// GET export ordini in Excel
// GET export ordini in Excel - UNA RIGA PER ORDINE
app.get('/api/admin/orders/export', adminAuth, async (req, res) => {
  try {
    const { statuses } = req.query;
    
    const where = {};
    if (statuses && statuses !== 'ALL') {
      where.paymentStatus = { in: statuses.split(',') };
    }
    
    const orders = await prisma.order.findMany({
      where,
      include: {
        items: {
          include: { product: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Genera Excel
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Ordini');

    // Header styling
    worksheet.columns = [
      { header: 'N. Ordine', key: 'orderNumber', width: 12 },
      { header: 'Codice Univoco', key: 'uniqueCode', width: 22 },
      { header: 'Data Ordine', key: 'date', width: 18 },
      { header: 'Cliente', key: 'customerName', width: 20 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Telefono', key: 'phone', width: 15 },
      { header: 'Stato', key: 'status', width: 12 },
      { header: 'Metodo Pag.', key: 'paymentMethod', width: 12 },
      { header: 'Prodotti', key: 'products', width: 50 },
      { header: 'N. Articoli', key: 'totalItems', width: 12 },
      { header: 'Subtotale', key: 'subtotal', width: 12 },
      { header: 'Sconto Bundle', key: 'discount', width: 14 },
      { header: 'Codice Promo', key: 'promoCode', width: 14 },
      { header: 'Sconto Promo', key: 'promoDiscount', width: 14 },
      { header: 'Totale', key: 'total', width: 12 }
    ];

    // Stile header
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF000000' }
    };
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Popola righe - UNA per ordine
    orders.forEach(order => {
      // Costruisci stringa prodotti
      const productsText = order.items.map(item => 
        `${item.quantity}x ${item.product.name} - ${item.color} (${item.size}) = €${item.lineTotal.toFixed(2)}`
      ).join('\n');

      // Conta totale articoli
      const totalItems = order.items.reduce((sum, item) => sum + item.quantity, 0);

      worksheet.addRow({
        orderNumber: `#${order.orderNumber.toString().padStart(4, '0')}`,
        uniqueCode: order.uniqueCode || '',
        date: new Date(order.createdAt).toLocaleString('it-IT'),
        customerName: order.customerName || '',
        email: order.customerEmail,
        phone: order.customerPhone || '',
        status: order.paymentStatus,
        paymentMethod: order.paymentMethod === 'paypal' ? 'PayPal' : 'Revolut',
        products: productsText,
        totalItems: totalItems,
        subtotal: `€${order.subtotal.toFixed(2)}`,
        discount: order.discount > 0 ? `-€${order.discount.toFixed(2)}` : '',
        promoCode: order.promoCode || '',
        promoDiscount: order.promoDiscount > 0 ? `-€${order.promoDiscount.toFixed(2)}` : '',
        total: `€${order.total.toFixed(2)}`
      });
    });

    // Aggiungi bordi e wrap text per colonna prodotti
    worksheet.eachRow((row, rowNumber) => {
      row.eachCell((cell, colNumber) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
        
        // Wrap text per colonna prodotti (colonna 9)
        if (colNumber === 9) {
          cell.alignment = { 
            wrapText: true, 
            vertical: 'top',
            horizontal: 'left'
          };
        }
      });
      
      // Auto-height per righe con prodotti multipli (non per header)
      if (rowNumber > 1) {
        row.height = undefined; // Auto height
      }
    });

    // Invia file
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=ordini-${new Date().toISOString().split('T')[0]}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();
    
  } catch (error) {
    console.error('Error exporting orders:', error);
    res.status(500).json({ error: 'Errore nell\'esportazione: ' + error.message });
  }
});
// PUT aggiorna stato ordine
app.put('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    const { paymentStatus, paymentId, notes } = req.body;

    // 🆕 VALIDAZIONE: Impedisci salti di stato non validi
    if (paymentStatus) {
      const currentOrder = await prisma.order.findUnique({
        where: { id: req.params.id }
      });

      const invalidTransitions = {
        'PENDING': ['ORDERED', 'DELIVERED'], // PENDING può andare solo a PAID o FAILED
        'PAID': ['DELIVERED'], // PAID può andare solo a ORDERED
        'ORDERED': ['PAID', 'PENDING'], // ORDERED può andare solo a DELIVERED
        'DELIVERED': ['PENDING', 'PAID', 'ORDERED'] // DELIVERED è finale
      };

      if (invalidTransitions[currentOrder.paymentStatus]?.includes(paymentStatus)) {
        return res.status(400).json({ 
          error: `Transizione non valida: ${currentOrder.paymentStatus} → ${paymentStatus}` 
        });
      }
    }

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

    // Invia email se ordine confermato (solo PAID, non più per altri stati)
    if (paymentStatus === 'PAID' && order.customerEmail) {
      try {
        await sendOrderConfirmationEmail(order);
        console.log(`✅ Email sent to ${order.customerEmail}`);
      } catch (emailError) {
        console.error('❌ Email send failed:', emailError);
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
        uniqueCode: generateUniqueOrderCode(Date.now()),
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
    const uniqueCode = generateUniqueOrderCode(order.orderNumber);
    await prisma.order.update({
      where: { id: order.id },
      data: { uniqueCode }
    });

    res.json({
      orderId: order.id,
      orderNumber: order.orderNumber,
      uniqueCode: uniqueCode,
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
    const orderedOrders = await prisma.order.count({ where: { paymentStatus: 'ORDERED' } });
    
    const revenue = await prisma.order.aggregate({
      where: { 
        paymentStatus: { in: ['PAID','ORDERED', 'DELIVERED'] }
      },
      _sum: { total: true }
    });

    const topProducts = await prisma.orderItem.groupBy({
      by: ['productId'],
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 5
    });
    // 🆕 Analytics per metodo di pagamento
    const paypalOrders = await prisma.order.count({
      where: { 
        paymentMethod: 'paypal',
        paymentStatus: { in: ['PAID','ORDERED','DELIVERED'] }
      }
    });

    const revolutOrders = await prisma.order.count({
      where: { 
        paymentMethod: 'revolut',
        paymentStatus: { in: ['PAID','ORDERED','DELIVERED'] }
      }
    });

    const paypalRevenue = await prisma.order.aggregate({
      where: { 
        paymentMethod: 'paypal',
        paymentStatus: { in: ['PAID','ORDERED','DELIVERED'] }
      },
      _sum: { total: true }
    });

    const revolutRevenue = await prisma.order.aggregate({
      where: { 
        paymentMethod: 'revolut',
        paymentStatus: { in: ['PAID','ORDERED','DELIVERED'] }
      },
      _sum: { total: true }
    });

    res.json({
      totalOrders,
      paidOrders,
      deliveredOrders,
      orderedOrders,
      revenue: revenue._sum.total || 0,
      topProducts,
      paypalOrders,
      revolutOrders,
      paypalRevenue: paypalRevenue._sum.total || 0,
      revolutRevenue: revolutRevenue._sum.total || 0
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


// ==================================
// BATCH API - Gestione Lotti
// ==================================

// GET riepilogo ordini PAID (da ordinare)
app.get('/api/admin/orders/summary-to-order', adminAuth, async (req, res) => {
  try {
    const paidOrders = await prisma.order.findMany({
      where: {
        paymentStatus: 'PAID',
        batchId: null // Solo ordini non ancora in un lotto
      },
      include: {
        items: {
          include: { product: true }
        }
      },
      orderBy: { paidAt: 'asc' }
    });

    // Aggrega per prodotto → colore → taglia
    const summary = {};
    
    paidOrders.forEach(order => {
      order.items.forEach(item => {
        const productKey = item.product.name;
        
        if (!summary[productKey]) {
          summary[productKey] = {
            productName: item.product.name,
            total: 0,
            byColor: {}
          };
        }
        
        const color = item.color;
        if (!summary[productKey].byColor[color]) {
          summary[productKey].byColor[color] = {
            total: 0,
            bySize: {}
          };
        }
        
        const size = item.size;
        if (!summary[productKey].byColor[color].bySize[size]) {
          summary[productKey].byColor[color].bySize[size] = 0;
        }
        
        summary[productKey].byColor[color].bySize[size] += item.quantity;
        summary[productKey].byColor[color].total += item.quantity;
        summary[productKey].total += item.quantity;
      });
    });

    res.json({
      orders: paidOrders,
      summary: Object.values(summary),
      totalOrders: paidOrders.length,
      totalItems: paidOrders.reduce((sum, o) => sum + o.items.reduce((s, i) => s + i.quantity, 0), 0)
    });
  } catch (error) {
    console.error('Error fetching summary:', error);
    res.status(500).json({ error: 'Errore nel recupero riepilogo' });
  }
});

// POST crea nuovo lotto
app.post('/api/admin/batches', adminAuth, async (req, res) => {
  try {
    const { orderIds, supplierName, supplierCost, expectedDelivery, notes } = req.body;

    if (!orderIds || orderIds.length === 0) {
      return res.status(400).json({ error: 'Nessun ordine selezionato' });
    }

    // Crea il lotto
    const batch = await prisma.batch.create({
      data: {
        status: 'DRAFT',
        supplierName,
        supplierCost: supplierCost ? parseFloat(supplierCost) : null,
        expectedDelivery: expectedDelivery ? new Date(expectedDelivery) : null,
        notes
      }
    });

    // Aggiorna ordini
    await prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: {
        batchId: batch.id,
        paymentStatus: 'ORDERED'
      }
    });

    res.json(batch);
  } catch (error) {
    console.error('Error creating batch:', error);
    res.status(500).json({ error: 'Errore nella creazione lotto' });
  }
});

// GET lista lotti
app.get('/api/admin/batches', adminAuth, async (req, res) => {
  try {
    const batches = await prisma.batch.findMany({
      include: {
        orders: {
          include: {
            items: {
              include: { product: true }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(batches);
  } catch (error) {
    console.error('Error fetching batches:', error);
    res.status(500).json({ error: 'Errore nel recupero lotti' });
  }
});

// PUT aggiorna lotto
app.put('/api/admin/batches/:id', adminAuth, async (req, res) => {
  try {
    const { status, supplierName, supplierOrderId, supplierCost, expectedDelivery, receivedAt, notes } = req.body;

    const batch = await prisma.batch.update({
      where: { id: req.params.id },
      data: {
        ...(status && { status }),
        ...(supplierName !== undefined && { supplierName }),
        ...(supplierOrderId !== undefined && { supplierOrderId }),
        ...(supplierCost !== undefined && { supplierCost: parseFloat(supplierCost) }),
        ...(expectedDelivery !== undefined && { expectedDelivery: expectedDelivery ? new Date(expectedDelivery) : null }),
        ...(receivedAt !== undefined && { receivedAt: receivedAt ? new Date(receivedAt) : null }),
        ...(notes !== undefined && { notes }),
        ...(status === 'ORDERED' && !req.body.orderedAt && { orderedAt: new Date() })
      }
    });

    res.json(batch);
  } catch (error) {
    console.error('Error updating batch:', error);
    res.status(500).json({ error: 'Errore nell\'aggiornamento lotto' });
  }
});


// ==================================
// PRODUCT STATS API
// ==================================

app.get('/api/admin/products/stats', adminAuth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const where = {
      paymentStatus: { in: ['PAID', 'ORDERED', 'DELIVERED'] }
    };
    
    if (startDate && endDate) {
      where.createdAt = {
        gte: new Date(startDate),
        lte: new Date(endDate)
      };
    }

    const orders = await prisma.order.findMany({
      where,
      include: {
        items: {
          include: { product: true }
        }
      }
    });

    // Aggrega statistiche
    const stats = {};
    
    orders.forEach(order => {
      order.items.forEach(item => {
        const productId = item.product.id;
        
        if (!stats[productId]) {
          stats[productId] = {
            product: item.product,
            totalQuantity: 0,
            byColor: {},
            bySize: {},
            combinations: {}
          };
        }
        
        stats[productId].totalQuantity += item.quantity;
        
        // Per colore
        if (!stats[productId].byColor[item.color]) {
          stats[productId].byColor[item.color] = 0;
        }
        stats[productId].byColor[item.color] += item.quantity;
        
        // Per taglia
        if (!stats[productId].bySize[item.size]) {
          stats[productId].bySize[item.size] = 0;
        }
        stats[productId].bySize[item.size] += item.quantity;
        
        // Combinazioni
        const combo = `${item.color}-${item.size}`;
        if (!stats[productId].combinations[combo]) {
          stats[productId].combinations[combo] = {
            color: item.color,
            size: item.size,
            quantity: 0
          };
        }
        stats[productId].combinations[combo].quantity += item.quantity;
      });
    });

    res.json(Object.values(stats));
  } catch (error) {
    console.error('Error fetching product stats:', error);
    res.status(500).json({ error: 'Errore nel recupero statistiche' });
  }
});



// Brevo (ex-Sendinblue) per invio email
const SibApiV3Sdk = require('sib-api-v3-sdk');
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

async function sendOrderConfirmationEmail(order) {
  try {
    const itemsList = order.items.map(item => 
      `${item.quantity}x ${item.product.name} - ${item.color} (${item.size}) = €${item.lineTotal.toFixed(2)}`
    ).join('<br>');

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    
    sendSmtpEmail.subject = `Ordine #${order.orderNumber.toString().padStart(4, '0')} Confermato`;
    sendSmtpEmail.htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h2 style="color: #000; margin-bottom: 10px;">Ordine Confermato! 🎉</h2>
        </div>
        
        <p style="font-size: 16px;">Ciao <strong>${order.customerName}</strong>,</p>
        <p style="font-size: 16px;">Il tuo ordine <strong>#${order.orderNumber.toString().padStart(4, '0')}</strong> è stato confermato!</p>
        
        <div style="margin: 30px 0;">
          <h3 style="color: #333; margin-bottom: 15px;">📦 Dettagli Ordine:</h3>
          <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; border-left: 4px solid #000;">
            ${itemsList}
          </div>
        </div>
        
        <div style="background: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #666;">Subtotale:</td>
              <td style="padding: 8px 0; text-align: right; font-weight: bold;">€${order.subtotal.toFixed(2)}</td>
            </tr>
            ${order.discount > 0 ? `
            <tr>
              <td style="padding: 8px 0; color: #059669;">Sconto Bundle:</td>
              <td style="padding: 8px 0; text-align: right; font-weight: bold; color: #059669;">-€${order.discount.toFixed(2)}</td>
            </tr>
            ` : ''}
            ${order.promoDiscount > 0 ? `
            <tr>
              <td style="padding: 8px 0; color: #059669;">Codice ${order.promoCode}:</td>
              <td style="padding: 8px 0; text-align: right; font-weight: bold; color: #059669;">-€${order.promoDiscount.toFixed(2)}</td>
            </tr>
            ` : ''}
            <tr style="border-top: 2px solid #ddd;">
              <td style="padding: 15px 0 0 0; font-size: 18px; font-weight: bold;">TOTALE:</td>
              <td style="padding: 15px 0 0 0; text-align: right; font-size: 20px; font-weight: bold; color: #000;">€${order.total.toFixed(2)}</td>
            </tr>
          </table>
        </div>
        
        <div style="background: #e0f2fe; border-left: 4px solid #0284c7; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 0; color: #0c4a6e;">
            <strong>⏱️ Tempi di consegna:</strong> Riceverai la tua felpa entro <strong>3 settimane</strong>!
          </p>
        </div>
        
        <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center;">
          <p style="color: #666; margin: 5px 0;">Grazie per il tuo ordine!</p>
          <p style="font-weight: bold; font-size: 18px; margin: 10px 0;">CLASSE VENETA</p>
        </div>
      </div>
    `;
    
    sendSmtpEmail.sender = { 
      name: "CLASSE VENETA", 
      email: "classeveneta@gmail.com" 
    };
    
    sendSmtpEmail.to = [{ 
      email: order.customerEmail, 
      name: order.customerName 
    }];

    await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log(`✅ Email inviata a ${order.customerEmail}`);
    
  } catch (error) {
    console.error('❌ Errore invio email:', error);
    if (error.response) {
      console.error('Dettagli errore Brevo:', error.response.text);
    }
    throw error;
  }
}

// ==================================
// HELPER: Genera Codice Univoco Ordine
// ==================================
function generateUniqueOrderCode(orderNumber) {
  // Formato: MIDA-XXXX-YYYY
  // XXXX = numero ordine (4 cifre)
  // YYYY = hash alfanumerico (4 caratteri)
  
  const paddedNumber = orderNumber.toString().padStart(4, '0');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Senza 0, O, I, 1 per evitare confusione
  let hash = '';
  
  for (let i = 0; i < 4; i++) {
    hash += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return `CLA$$EV€N€TA-${paddedNumber}-${hash}`;
}

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
// INIZIALIZZA CONFIGURAZIONI DEFAULT
// ==================================
async function initializeDefaultConfigs() {
  try {
    // Config promo codes visible
    const promoConfig = await prisma.config.findUnique({
      where: { key: 'promo_codes_visible' }
    });
    
    if (!promoConfig) {
      await prisma.config.create({
        data: {
          key: 'promo_codes_visible',
          value: { visible: true },
          description: 'Mostra il campo codici promo nel checkout'
        }
      });
      console.log('✅ Config promo_codes_visible inizializzata');
    }
  } catch (error) {
    console.error('❌ Errore inizializzazione config:', error);
  }
}

// ==================================
// START SERVER
// ==================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 MIDA Merch Backend running on port ${PORT}`);
    //Inizializza config al primo avvio (non bloccante)
    initializeDefaultConfigs().catch(err => {
      console.error('❌ Errore inizializzazione config:', err);
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server...');
  await prisma.$disconnect();
  process.exit(0);
});
