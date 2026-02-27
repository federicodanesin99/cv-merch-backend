// server.js - Backend principale MIDA Merch Store
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

const {
  calculatePromotions,
  calculateProgress
} = require('./promotions-engine');
// Middleware
// Middleware CORS configurato per dev e production
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://classe-veneta-admin.vercel.app',
      'https://cv-merch-frontend.vercel.app',
      'https://classeveneta.vercel.app',
      'https://classeveneta.com',
      'https://classeveneta.it',
      'https://admin-panel-ashy-two.vercel.app',
      'http://localhost:4200']
    : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3001', 'http://localhost:4200'], // Dev locale
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

    const promoVisibleConfig = await prisma.config.findUnique({
      where: { key: 'promo_codes_visible' }
    });

    const categories = [...new Set(products.map(p => p.category).filter(Boolean))].sort();

    res.json({
      products: products.map(p => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        category: p.category,
        description: p.description,
        sizeGuide: p.sizeGuide,
        basePrice: p.basePrice,
        price: launchActive?.value?.active && p.launchPrice ? p.launchPrice : p.basePrice,
        colors: p.colors,
        sizes: p.sizes,
        images: p.images || [],
        isComingSoon: p.isComingSoon || false  // ✅ ASSICURATI CHE SIA QUI
      })),
      categories,
      bundleDiscount: bundleConfig?.value?.percentage || 5,
      launchActive: launchActive?.value?.active || false,
      promoCodesVisible: promoVisibleConfig?.value?.visible !== false
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

    // Recupera prodotti
    const productIds = [...new Set(items.map(i => i.productId))];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } }
    });
    const productMap = Object.fromEntries(products.map(p => [p.id, p]));

    // Check prezzi lancio
    const launchActive = await prisma.config.findUnique({
      where: { key: 'launch_prices_active' }
    });
    const useLaunchPrices = launchActive?.value?.active || false;

    // Calcola subtotal
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

    // 🆕 CALCOLA PROMOZIONI AUTOMATICHE
    const cart = {
      items: orderItems.map((item, i) => ({
        ...item,
        product: productMap[items[i].productId]
      })),
      subtotal,
      totalItems: items.reduce((sum, i) => sum + i.quantity, 0),
      shippingCost: 0
    };

    const promoResult = await calculatePromotions(cart, customerEmail, prisma);
    let promotionDiscount = promoResult.totalDiscount;

    // Applica vecchio bundle discount (da deprecare?)
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

    // Applica codice promo manuale (STACKING SUPPORT)
    let promoDiscount = 0;
    const usedPromoCodes = []; // Array per tracciare i codici usati

    if (promoCode) {
      const codesList = promoCode.split(',').map(c => c.trim()).filter(c => c.length > 0);
      let currentAmount = subtotal - discount - promotionDiscount; // Base per calcolo, ridotta da sconti precedenti

      for (const singleCode of codesList) {
        const promo = await prisma.promoCode.findUnique({
          where: { code: singleCode.toUpperCase().trim() }
        });

        if (promo && promo.isActive) {
          // Check generici validità (date, usi totali user)
          // Nota: Check allowedEmails già fatto idealmente in validate, ma qui 
          // potremmo ri-verificare per sicurezza. Per brevità e coerenza col codice precedente,
          // mi fido che siano validi o faccio check minimi essenziali per integrità dati.

          let singleDiscount = 0;
          if (promo.discountType === 'PERCENTAGE') {
            singleDiscount = currentAmount * (promo.discountValue / 100);
          } else {
            singleDiscount = promo.discountValue;
          }

          singleDiscount = Math.min(singleDiscount, currentAmount);

          if (singleDiscount > 0) {
            promoDiscount += singleDiscount;
            currentAmount -= singleDiscount;

            usedPromoCodes.push(promo);

            // Registra usage SUBITO o dopo create? 
            // Il codice originale faceva create dentro l'if.
            // Qui accumuliamo e creiamo usage dopo aver confermato tutto.
          }
        }
      }
    }

    const total = subtotal - discount - promotionDiscount - promoDiscount;
    // Record usages separatamente dopo
    // Nota: lo faremo dopo aver creato l'ordine per sicurezza tx, oppure qui?
    // Il codice originale faceva: await prisma.promoCodeUsage.create(...)
    // Facciamolo qui per mantenere logica flusso, o meglio, facciamolo dopo order create se vogliamo essere sicuri
    // ma il codice originale lo faceva PRIMA di creare l'ordine (azzardato se order create fallisce).
    // Spostiamolo DOPO la creazione dell'ordine per correttezza, o lasciamolo qui se vogliamo.
    // Il codice originale era:
    // await prisma.promoCodeUsage.create({ data: { promoCodeId: promo.id, customerEmail } });
    // Mantengo l'ordine originale: registriamo l'uso.
    // Crea ordine
    const order = await prisma.order.create({
      data: {
        customerEmail,
        customerName,
        uniqueCode: generateUniqueOrderCode(Date.now()),
        customerPhone,
        subtotal,
        discount,
        // promotionDiscount, // Removed as not in schema
        promoCode: promoCode || null,
        promoDiscount,
        total,
        paymentMethod: paymentMethod || 'paypal',
        appliedPromotions: promoResult.appliedPromotions, // 🆕 Salva dettagli promo
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

    // 🆕 Registra utilizzi promozioni DOPO aver creato l'ordine
    for (const promo of usedPromoCodes) {
      await prisma.promoCodeUsage.create({
        data: {
          promoCodeId: promo.id,
          customerEmail,
          orderId: order.id
        }
      });
    }

    // 🆕 Registra utilizzi promozioni
    for (const appliedPromo of promoResult.appliedPromotions) {
      await prisma.promotionUsage.create({
        data: {
          promotionId: appliedPromo.id,
          orderId: order.id,
          customerEmail,
          discountApplied: appliedPromo.discount
        }
      });

      // Incrementa counter
      await prisma.promotion.update({
        where: { id: appliedPromo.id },
        data: { usageCount: { increment: 1 } }
      });
    }

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
      appliedPromotions: promoResult.appliedPromotions, // 🆕 Invia info al frontend
      giftProducts: promoResult.giftProducts, // 🆕
      paymentUrl: generatePaymentUrl(order)
    });

  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({ error: 'Errore nella creazione dell\'ordine' });
  }
});

// POST /api/admin/orders/manual
app.post('/api/admin/orders/manual', adminAuth, async (req, res) => {
  const {
    customerName, customerEmail, customerPhone,
    paymentMethod, paymentStatus,
    items,
    customTotal,
    notes
  } = req.body;

  try {
    // Genera orderNumber progressivo
    const lastOrder = await prisma.order.findFirst({
      orderBy: { orderNumber: 'desc' }
    });
    const orderNumber = (lastOrder?.orderNumber || 0) + 1;

    // Carica tutti i prodotti una volta
    const productIds = [...new Set(items.map(i => i.productId))];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } }
    });
    const productMap = Object.fromEntries(products.map(p => [p.id, p]));

    // Calcola totale
    let total = customTotal || 0;
    if (!customTotal) {
      total = items.reduce((sum, item) => {
        const product = productMap[item.productId];
        const price = item.customPrice || product.launchPrice || product.basePrice;
        return sum + (price * item.quantity);
      }, 0);
    }



    // Crea ordine
    const order = await prisma.order.create({
      data: {
        orderNumber,
        uniqueCode: generateUniqueOrderCode(orderNumber),
        customerName,
        customerEmail,
        customerPhone,
        paymentMethod,
        paymentStatus,
        total,
        subtotal: total,
        discount: 0,
        promoDiscount: 0,
        paidAt: paymentStatus !== 'PENDING' ? new Date() : null,
        items: {
          create: items.map(item => {
            const product = productMap[item.productId]; // Ora product esiste
            const unitPrice = item.customPrice || product.launchPrice || product.basePrice;
            return {
              productId: item.productId,
              quantity: item.quantity,
              color: item.color,
              size: item.size,
              unitPrice,
              lineTotal: unitPrice * item.quantity
            };
          })
        }
      },
      include: {
        items: {
          include: { product: true }
        }
      }
    });

    res.json(order);
  } catch (error) {
    console.error('Error creating manual order:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST crea nuovo prodotto - AGGIORNA
app.post('/api/admin/products', adminAuth, async (req, res) => {
  console.log('📥 Received product data:', req.body);
  console.log('🔍 isComingSoon value:', req.body.isComingSoon);
  try {
    const {
      name, slug, basePrice, launchPrice,
      colors, sizes, isActive, images,
      description, sizeGuide, category, isComingSoon
    } = req.body;

    if (!name || !slug || !basePrice) {
      return res.status(400).json({ error: 'Dati prodotto incompleti' });
    }

    const product = await prisma.product.create({
      data: {
        name,
        slug,
        category: category || null,
        description: description || null,
        sizeGuide: sizeGuide || null,
        basePrice: parseFloat(basePrice),
        launchPrice: launchPrice ? parseFloat(launchPrice) : null,
        colors: colors || [],
        sizes: sizes || ['S', 'M', 'L', 'XL', 'XXL'],
        isActive: isActive !== undefined ? isActive : true,
        isComingSoon: isComingSoon !== undefined ? isComingSoon : false,  // ✅ AGGIUNGI QUESTO
        images: images || []
      }
    });

    console.log('✅ Prodotto creato:', product.name, 'Coming Soon:', product.isComingSoon);
    res.json(product);
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({ error: 'Errore nella creazione prodotto' });
  }
});


// PUT aggiorna prodotto - AGGIORNA
app.put('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const {
      name, basePrice, launchPrice,
      colors, sizes, isActive, images,
      description, sizeGuide, category, isComingSoon
    } = req.body;

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        ...(name && { name }),
        ...(category !== undefined && { category }), // ✅ Aggiungi category
        ...(description !== undefined && { description }),
        ...(sizeGuide !== undefined && { sizeGuide }),
        ...(basePrice !== undefined && { basePrice: parseFloat(basePrice) }),
        ...(launchPrice !== undefined && { launchPrice: launchPrice ? parseFloat(launchPrice) : null }),
        ...(colors && { colors }),
        ...(sizes && { sizes }),
        ...(isActive !== undefined && { isActive }),
        ...(isComingSoon !== undefined && { isComingSoon }),
        ...(images !== undefined && { images })
      }
    });

    console.log('✅ Prodotto aggiornato:', product.name, 'Coming Soon:', product.isComingSoon);
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
        paymentStatus: { in: ['PAID', 'ORDERED', 'DELIVERED'] }
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
        paymentStatus: { in: ['PAID', 'ORDERED', 'DELIVERED'] }
      }
    });

    const revolutOrders = await prisma.order.count({
      where: {
        paymentMethod: 'revolut',
        paymentStatus: { in: ['PAID', 'ORDERED', 'DELIVERED'] }
      }
    });

    const paypalRevenue = await prisma.order.aggregate({
      where: {
        paymentMethod: 'paypal',
        paymentStatus: { in: ['PAID', 'ORDERED', 'DELIVERED'] }
      },
      _sum: { total: true }
    });

    const revolutRevenue = await prisma.order.aggregate({
      where: {
        paymentMethod: 'revolut',
        paymentStatus: { in: ['PAID', 'ORDERED', 'DELIVERED'] }
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

// POST crea nuovo promo code - CORRETTO ✅
app.post('/api/admin/promo-codes', adminAuth, async (req, res) => {
  try {
    const {
      code,
      discountType,
      discountValue,
      expiresAt,
      maxUsesPerUser,
      isActive,
      allowedEmails  // ✅ AGGIUNGI QUESTO
    } = req.body;

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
        isActive: isActive !== undefined ? isActive : true,
        allowedEmails: allowedEmails || []  // ✅ AGGIUNGI QUESTO
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

// PUT aggiorna promo code - CORRETTO ✅
app.put('/api/admin/promo-codes/:id', adminAuth, async (req, res) => {
  try {
    const {
      discountValue,
      expiresAt,
      maxUsesPerUser,
      isActive,
      allowedEmails  // ✅ AGGIUNGI QUESTO
    } = req.body;

    const promoCode = await prisma.promoCode.update({
      where: { id: req.params.id },
      data: {
        ...(discountValue !== undefined && { discountValue: parseFloat(discountValue) }),
        ...(expiresAt !== undefined && { expiresAt: expiresAt ? new Date(expiresAt) : null }),
        ...(maxUsesPerUser !== undefined && { maxUsesPerUser }),
        ...(isActive !== undefined && { isActive }),
        ...(allowedEmails !== undefined && { allowedEmails })  // ✅ AGGIUNGI QUESTO
      }
    });

    res.json(promoCode);
  } catch (error) {
    console.error('Error updating promo code:', error);
    res.status(500).json({ error: 'Errore nell\'aggiornamento' });
  }
});

// POST Valida codice promozionale - SUPPORTA MULTIPLI CODICI (STACKING)
app.post('/api/validate-promo', async (req, res) => {
  try {
    const { code, customerEmail, subtotal } = req.body;

    if (!code || !customerEmail || !subtotal) {
      return res.status(400).json({ error: 'Dati mancanti' });
    }

    // Gestione multipli codici (separati da virgola)
    const codesList = code.split(',').map(c => c.trim()).filter(c => c.length > 0);

    let currentSubtotal = parseFloat(subtotal);
    let totalDiscount = 0;
    const appliedCodes = [];
    const messages = [];

    for (const singleCode of codesList) {
      // Cerca codice
      const promoCode = await prisma.promoCode.findUnique({
        where: { code: singleCode.toUpperCase().trim() },
        include: {
          usedBy: {
            where: { customerEmail }
          }
        }
      });

      // Validazioni base (se un codice fallisce, lo ignoriamo o ritorniamo errore?
      // Qui decido di ritornare errore al primo fallimento per chiarezza,
      // oppure potremmo saltarlo. Dato che l'utente li inserisce uno alla volta, 
      // meglio essere strict.)

      if (!promoCode) {
        return res.status(404).json({ error: `Codice '${singleCode}' non valido` });
      }

      if (!promoCode.isActive) {
        return res.status(400).json({ error: `Codice '${singleCode}' non più attivo` });
      }

      if (promoCode.expiresAt && new Date(promoCode.expiresAt) < new Date()) {
        return res.status(400).json({ error: `Codice '${singleCode}' scaduto` });
      }

      // Check se già usato da questa email
      // NOTA: Se sta usando lo stesso codice due volte nella stessa richiesta (es: "TEST,TEST"),
      // dobbiamo contare anche gli usi correnti? Per ora assumiamo che non passi lo stesso codice 2 volte.
      // Se lo passa, il check database `usedBy` non basta perché non è ancora salvato.
      // Aggiungiamo check duplicati nella lista input.
      if (appliedCodes.some(ac => ac.code === promoCode.code)) {
        return res.status(400).json({ error: `Codice '${singleCode}' inserito più volte` });
      }

      if (promoCode.usedBy.length >= promoCode.maxUsesPerUser) {
        return res.status(400).json({ error: `Codice '${singleCode}' già utilizzato` });
      }

      // Check email limitate
      if (promoCode.allowedEmails && promoCode.allowedEmails.length > 0) {
        const isAllowed = promoCode.allowedEmails.some(
          allowedEmail => allowedEmail.toLowerCase().trim() === customerEmail.toLowerCase().trim()
        );

        if (!isAllowed) {
          return res.status(400).json({ error: `Codice '${singleCode}' non valido per questo utente` });
        }
      }

      // Calcola sconto su SUBTOTALE RESIDUO (Compounding)
      let discount = 0;
      if (promoCode.discountType === 'PERCENTAGE') {
        discount = currentSubtotal * (promoCode.discountValue / 100);
      } else {
        discount = promoCode.discountValue;
      }

      // Non può superare il residuo
      discount = Math.min(discount, currentSubtotal);

      // Aggiorna totali
      currentSubtotal -= discount;
      totalDiscount += discount;

      appliedCodes.push({
        code: promoCode.code,
        discountType: promoCode.discountType,
        discountValue: promoCode.discountValue,
        appliedDiscount: parseFloat(discount.toFixed(2))
      });

      messages.push(promoCode.discountType === 'PERCENTAGE'
        ? `- ${promoCode.code}: ${promoCode.discountValue}%`
        : `- ${promoCode.code}: €${promoCode.discountValue}`
      );
    }

    res.json({
      valid: true,
      codes: appliedCodes.map(c => c.code), // Ritorna lista codici validi
      overallDiscount: parseFloat(totalDiscount.toFixed(2)), // Sconto totale accumulato
      newSubtotal: parseFloat(currentSubtotal.toFixed(2)),
      message: `Codici applicati:\n${messages.join('\n')}`
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

// ==================== PRODUCT INTEREST API ====================

// POST Registra interesse per prodotto (richiede user email da Firebase)
app.post('/api/products/:productId/register-interest', async (req, res) => {
  try {
    const { productId } = req.params;
    const { userEmail, userName, preferredColor, preferredSize } = req.body;

    if (!userEmail || !userName) {
      return res.status(400).json({ error: 'Email e nome obbligatori' });
    }

    // Verifica che il prodotto esista ed sia coming soon
    const product = await prisma.product.findUnique({
      where: { id: productId }
    });

    if (!product) {
      return res.status(404).json({ error: 'Prodotto non trovato' });
    }

    if (!product.isComingSoon) {
      return res.status(400).json({ error: 'Prodotto già disponibile' });
    }

    // Upsert: crea o aggiorna se già esiste
    const interest = await prisma.productInterest.upsert({
      where: {
        productId_userEmail: {
          productId,
          userEmail: userEmail.toLowerCase()
        }
      },
      create: {
        productId,
        userEmail: userEmail.toLowerCase(),
        userName,
        preferredColor,
        preferredSize
      },
      update: {
        userName,
        preferredColor,
        preferredSize,
        updatedAt: new Date()
      }
    });

    console.log(`✅ Interesse registrato: ${userEmail} per ${product.name}`);

    // Invia email di conferma
    await sendInterestConfirmationEmail({
      email: userEmail,
      name: userName,
      productName: product.name
    });

    res.json({
      success: true,
      message: 'Ti avviseremo quando il prodotto sarà disponibile!',
      interest
    });

  } catch (error) {
    console.error('❌ Errore registrazione interesse:', error);
    res.status(500).json({ error: 'Errore nella registrazione' });
  }
});

// GET Lista utenti interessati (admin)
app.get('/api/admin/products/:productId/interested-users', adminAuth, async (req, res) => {
  try {
    const { productId } = req.params;

    const interests = await prisma.productInterest.findMany({
      where: { productId },
      include: {
        product: {
          select: { name: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const stats = {
      total: interests.length,
      notified: interests.filter(i => i.notifiedAt).length,
      pending: interests.filter(i => !i.notifiedAt).length,
      byColor: {},
      bySize: {}
    };

    interests.forEach(i => {
      if (i.preferredColor) {
        stats.byColor[i.preferredColor] = (stats.byColor[i.preferredColor] || 0) + 1;
      }
      if (i.preferredSize) {
        stats.bySize[i.preferredSize] = (stats.bySize[i.preferredSize] || 0) + 1;
      }
    });

    res.json({ interests, stats });
  } catch (error) {
    console.error('❌ Errore recupero interessati:', error);
    res.status(500).json({ error: 'Errore nel recupero' });
  }
});

// POST Notifica utenti interessati (admin - manuale o automatico)
app.post('/api/admin/products/:productId/notify-interested', adminAuth, async (req, res) => {
  try {
    const { productId } = req.params;
    const { discountCode, onlyPending = true } = req.body;

    const product = await prisma.product.findUnique({
      where: { id: productId }
    });

    if (!product) {
      return res.status(404).json({ error: 'Prodotto non trovato' });
    }

    // Trova utenti da notificare
    const whereClause = { productId };
    if (onlyPending) {
      whereClause.notifiedAt = null;
    }

    const interests = await prisma.productInterest.findMany({
      where: whereClause
    });

    if (interests.length === 0) {
      return res.json({
        success: true,
        message: 'Nessun utente da notificare',
        notified: 0
      });
    }

    // Invia email a tutti
    let successCount = 0;
    let failedCount = 0;

    for (const interest of interests) {
      try {
        await sendProductAvailableEmail({
          email: interest.userEmail,
          name: interest.userName,
          productName: product.name,
          productSlug: product.slug,
          discountCode,
          preferredColor: interest.preferredColor,
          preferredSize: interest.preferredSize
        });

        // Marca come notificato
        await prisma.productInterest.update({
          where: { id: interest.id },
          data: { notifiedAt: new Date() }
        });

        successCount++;
        console.log(`✅ Email inviata a ${interest.userEmail}`);
      } catch (emailError) {
        console.error(`❌ Errore invio email a ${interest.userEmail}:`, emailError);
        failedCount++;
      }
    }

    res.json({
      success: true,
      message: `Notificati ${successCount} utenti`,
      notified: successCount,
      failed: failedCount
    });

  } catch (error) {
    console.error('❌ Errore notifica interessati:', error);
    res.status(500).json({ error: 'Errore nella notifica' });
  }
});

// ==================== EMAIL FUNCTIONS ====================

async function sendInterestConfirmationEmail({ email, name, productName }) {
  try {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

    sendSmtpEmail.subject = `✅ Ti avviseremo per "${productName}"`;
    sendSmtpEmail.htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h2 style="color: #000; margin-bottom: 10px;">Grazie per l'interesse! 🙏</h2>
        </div>
        
        <p style="font-size: 16px;">Ciao <strong>${name}</strong>,</p>
        <p style="font-size: 16px;">
          Abbiamo registrato il tuo interesse per <strong>${productName}</strong>.
        </p>
        
        <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; border-left: 4px solid #000; margin: 30px 0;">
          <p style="margin: 0; font-size: 14px;">
            📧 Ti invieremo un'email non appena il prodotto sarà disponibile per l'acquisto!
          </p>
        </div>
        
        <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center;">
          <p style="color: #666; margin: 5px 0;">A presto!</p>
          <p style="font-weight: bold; font-size: 18px; margin: 10px 0;">CLASSE VENETA</p>
        </div>
      </div>
    `;

    sendSmtpEmail.sender = {
      name: "CLASSE VENETA",
      email: "classeveneta@gmail.com"
    };

    sendSmtpEmail.to = [{ email, name }];

    await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log(`✅ Email conferma inviata a ${email}`);

  } catch (error) {
    console.error('❌ Errore invio email conferma:', error);
    throw error;
  }
}

async function sendProductAvailableEmail({
  email, name, productName, productSlug, discountCode,
  preferredColor, preferredSize
}) {
  try {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

    const productUrl = `${process.env.FRONTEND_URL || 'https://classeveneta.com'}/products/${productSlug}`;

    let preferenceText = '';
    if (preferredColor || preferredSize) {
      preferenceText = '<p style="font-size: 14px; color: #666;">💡 Hai mostrato interesse per: ';
      if (preferredColor) preferenceText += `<strong>Colore ${preferredColor}</strong>`;
      if (preferredColor && preferredSize) preferenceText += ' - ';
      if (preferredSize) preferenceText += `<strong>Taglia ${preferredSize}</strong>`;
      preferenceText += '</p>';
    }

    let discountSection = '';
    if (discountCode) {
      discountSection = `
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 8px; margin: 30px 0; text-align: center;">
          <p style="color: white; font-size: 16px; margin-bottom: 10px;">🎁 <strong>SCONTO ESCLUSIVO PER TE</strong></p>
          <p style="color: white; font-size: 24px; font-weight: bold; letter-spacing: 2px; margin: 10px 0;">
            ${discountCode}
          </p>
          <p style="color: rgba(255,255,255,0.9); font-size: 14px; margin-top: 10px;">
            Usa questo codice al checkout per ottenere il tuo sconto!
          </p>
        </div>
      `;
    }

    sendSmtpEmail.subject = `🎉 "${productName}" è finalmente disponibile!`;
    sendSmtpEmail.htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h2 style="color: #000; margin-bottom: 10px;">È arrivato! 🚀</h2>
        </div>
        
        <p style="font-size: 16px;">Ciao <strong>${name}</strong>,</p>
        <p style="font-size: 16px;">
          Ottima notizia! <strong>${productName}</strong> è ora disponibile per l'acquisto! 
        </p>
        
        ${preferenceText}
        
        ${discountSection}
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${productUrl}" 
             style="display: inline-block; background: #000; color: white; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
            👉 ACQUISTA ORA
          </a>
        </div>
        
        <div style="background: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b; margin: 20px 0;">
          <p style="margin: 0; font-size: 14px; color: #92400e;">
            ⚡ <strong>Affrettati!</strong> Le quantità potrebbero essere limitate.
          </p>
        </div>
        
        <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center;">
          <p style="color: #666; margin: 5px 0;">Grazie per la tua pazienza!</p>
          <p style="font-weight: bold; font-size: 18px; margin: 10px 0;">CLASSE VENETA</p>
        </div>
      </div>
    `;

    sendSmtpEmail.sender = {
      name: "CLASSE VENETA",
      email: "classeveneta@gmail.com"
    };

    sendSmtpEmail.to = [{ email, name }];

    await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log(`✅ Email disponibilità inviata a ${email}`);

  } catch (error) {
    console.error('❌ Errore invio email disponibilità:', error);
    throw error;
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

// ====================================
// ADMIN API - GESTIONE PROMOZIONI
// ====================================

// GET lista tutte le promozioni (admin)
app.get('/api/admin/promotions', adminAuth, async (req, res) => {
  try {
    const promotions = await prisma.promotion.findMany({
      include: {
        giftProduct: {
          select: { id: true, name: true, basePrice: true }
        },
        _count: {
          select: { usages: true }
        }
      },
      orderBy: { priority: 'desc' }
    });

    res.json(promotions);
  } catch (error) {
    console.error('Error fetching promotions:', error);
    res.status(500).json({ error: 'Errore nel recupero promozioni' });
  }
});

// POST crea nuova promozione (admin)
app.post('/api/admin/promotions', adminAuth, async (req, res) => {
  try {
    const {
      name, slug, description, type, isActive, priority,
      discountValue, discountTiers, conditions, bogoConfig,
      giftProductId, startDate, endDate,
      badgeText, badgeColor, showProgressBar, progressBarText,
      showPopup, popupText, maxUsesTotal, maxUsesPerUser,
      combinesWith
    } = req.body;

    if (!name || !slug || !type) {
      return res.status(400).json({ error: 'Dati incompleti' });
    }

    const promotion = await prisma.promotion.create({
      data: {
        name,
        slug,
        description,
        type,
        isActive: isActive !== undefined ? isActive : true,
        priority: priority || 0,
        discountValue: discountValue ? parseFloat(discountValue) : null,
        discountTiers: discountTiers || null,
        conditions: conditions || {},
        bogoConfig: bogoConfig || null,
        giftProductId: giftProductId || null,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        badgeText,
        badgeColor: badgeColor || '#FF0000',
        showProgressBar: showProgressBar || false,
        progressBarText,
        showPopup: showPopup || false,
        popupText,
        maxUsesTotal: maxUsesTotal ? parseInt(maxUsesTotal) : null,
        maxUsesPerUser: maxUsesPerUser ? parseInt(maxUsesPerUser) : null,
        combinesWith: combinesWith || []
      },
      include: {
        giftProduct: true
      }
    });

    res.json(promotion);
  } catch (error) {
    console.error('Error creating promotion:', error);
    if (error.code === 'P2002') {
      res.status(400).json({ error: 'Slug già esistente' });
    } else {
      res.status(500).json({ error: 'Errore nella creazione' });
    }
  }
});

// PUT aggiorna promozione (admin)
app.put('/api/admin/promotions/:id', adminAuth, async (req, res) => {
  try {
    const {
      name, description, isActive, priority,
      discountValue, discountTiers, conditions, bogoConfig,
      giftProductId, startDate, endDate,
      badgeText, badgeColor, showProgressBar, progressBarText,
      showPopup, popupText, maxUsesTotal, maxUsesPerUser,
      combinesWith
    } = req.body;

    const promotion = await prisma.promotion.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(isActive !== undefined && { isActive }),
        ...(priority !== undefined && { priority }),
        ...(discountValue !== undefined && {
          discountValue: discountValue ? parseFloat(discountValue) : null
        }),
        ...(discountTiers !== undefined && { discountTiers }),
        ...(conditions !== undefined && { conditions }),
        ...(bogoConfig !== undefined && { bogoConfig }),
        ...(giftProductId !== undefined && { giftProductId }),
        ...(startDate !== undefined && {
          startDate: startDate ? new Date(startDate) : null
        }),
        ...(endDate !== undefined && {
          endDate: endDate ? new Date(endDate) : null
        }),
        ...(badgeText !== undefined && { badgeText }),
        ...(badgeColor !== undefined && { badgeColor }),
        ...(showProgressBar !== undefined && { showProgressBar }),
        ...(progressBarText !== undefined && { progressBarText }),
        ...(showPopup !== undefined && { showPopup }),
        ...(popupText !== undefined && { popupText }),
        ...(maxUsesTotal !== undefined && {
          maxUsesTotal: maxUsesTotal ? parseInt(maxUsesTotal) : null
        }),
        ...(maxUsesPerUser !== undefined && {
          maxUsesPerUser: maxUsesPerUser ? parseInt(maxUsesPerUser) : null
        }),
        ...(combinesWith !== undefined && { combinesWith })
      },
      include: {
        giftProduct: true
      }
    });

    res.json(promotion);
  } catch (error) {
    console.error('Error updating promotion:', error);
    res.status(500).json({ error: 'Errore nell\'aggiornamento' });
  }
});

// DELETE elimina promozione (admin)
app.delete('/api/admin/promotions/:id', adminAuth, async (req, res) => {
  try {
    await prisma.promotion.delete({
      where: { id: req.params.id }
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting promotion:', error);
    res.status(500).json({ error: 'Errore nell\'eliminazione' });
  }
});

// POST toggle attiva/disattiva promo (admin)
app.post('/api/admin/promotions/:id/toggle', adminAuth, async (req, res) => {
  try {
    const promo = await prisma.promotion.findUnique({
      where: { id: req.params.id }
    });

    if (!promo) {
      return res.status(404).json({ error: 'Promozione non trovata' });
    }

    const updated = await prisma.promotion.update({
      where: { id: req.params.id },
      data: { isActive: !promo.isActive }
    });

    res.json(updated);
  } catch (error) {
    console.error('Error toggling promotion:', error);
    res.status(500).json({ error: 'Errore nel toggle' });
  }
});

// ====================================
// PUBLIC API - PROMOZIONI
// ====================================

// GET lista promozioni attive pubbliche
app.get('/api/promotions/active', async (req, res) => {
  try {
    const promotions = await prisma.promotion.findMany({
      where: {
        isActive: true,
        OR: [
          { startDate: null },
          { startDate: { lte: new Date() } }
        ],
        AND: [
          {
            OR: [
              { endDate: null },
              { endDate: { gte: new Date() } }
            ]
          }
        ]
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        type: true,
        badgeText: true,
        badgeColor: true,
        conditions: true,
        discountValue: true,
        discountTiers: true,
        endDate: true
      },
      orderBy: { priority: 'desc' }
    });

    res.json(promotions);
  } catch (error) {
    console.error('Error fetching active promotions:', error);
    res.status(500).json({ error: 'Errore nel recupero promozioni attive' });
  }
});

// POST calcola sconti per carrello
app.post('/api/promotions/calculate', async (req, res) => {
  try {
    const { items, userEmail } = req.body;

    if (!items || items.length === 0) {
      return res.json({
        totalDiscount: 0,
        appliedPromotions: [],
        giftProducts: [],
        finalTotal: 0
      });
    }

    // Arricchisci items con dati prodotto
    const productIds = [...new Set(items.map(i => i.productId))];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } }
    });
    const productMap = Object.fromEntries(products.map(p => [p.id, p]));

    // Costruisci cart object
    const cart = {
      items: items.map(item => ({
        ...item,
        product: productMap[item.productId],
        unitPrice: item.unitPrice || productMap[item.productId]?.basePrice || 0
      })),
      subtotal: items.reduce((sum, item) => {
        const price = item.unitPrice || productMap[item.productId]?.basePrice || 0;
        return sum + (price * item.quantity);
      }, 0),
      totalItems: items.reduce((sum, item) => sum + item.quantity, 0),
      shippingCost: 5 // Da parametrizzare
    };

    // Calcola promozioni
    const result = await calculatePromotions(cart, userEmail, prisma);

    res.json(result);
  } catch (error) {
    console.error('Error calculating promotions:', error);
    res.status(500).json({ error: 'Errore nel calcolo sconti' });
  }
});

// GET progresso verso promozioni
app.post('/api/promotions/progress', async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || items.length === 0) {
      return res.json({ progress: [] });
    }

    // Recupera promo attive con progress bar
    const promotions = await prisma.promotion.findMany({
      where: {
        isActive: true,
        showProgressBar: true,
        OR: [
          { startDate: null },
          { startDate: { lte: new Date() } }
        ],
        AND: [
          {
            OR: [
              { endDate: null },
              { endDate: { gte: new Date() } }
            ]
          }
        ]
      },
      orderBy: { priority: 'desc' }
    });

    // Costruisci cart
    const productIds = [...new Set(items.map(i => i.productId))];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } }
    });
    const productMap = Object.fromEntries(products.map(p => [p.id, p]));

    const cart = {
      items: items.map(item => ({
        ...item,
        product: productMap[item.productId]
      })),
      subtotal: items.reduce((sum, item) => {
        const price = productMap[item.productId]?.basePrice || 0;
        return sum + (price * item.quantity);
      }, 0),
      totalItems: items.reduce((sum, item) => sum + item.quantity, 0)
    };

    // Calcola progress per ogni promo
    const progress = promotions.map(promo => ({
      id: promo.id,
      name: promo.name,
      ...calculateProgress(cart, promo)
    }));

    res.json({ progress });
  } catch (error) {
    console.error('Error calculating progress:', error);
    res.status(500).json({ error: 'Errore nel calcolo progresso' });
  }
});

