// promotions-engine.js - Logica di calcolo sconti avanzata

/**
 * 🎯 MOTORE PRINCIPALE: Calcola tutte le promo applicabili
 */
async function calculatePromotions(cart, userEmail, prisma) {
  // 1️⃣ Recupera promo attive ordinate per priorità
  const activePromos = await prisma.promotion.findMany({
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
    include: {
      giftProduct: true
    },
    orderBy: { priority: 'desc' }
  });

  let totalDiscount = 0;
  let appliedPromotions = [];
  let giftProducts = [];
  let processedPromoIds = new Set();
  
  // 2️⃣ Itera promo in ordine di priorità
  for (const promo of activePromos) {
    // Skip se già processata (per combinabilità)
    if (processedPromoIds.has(promo.id)) continue;
    
    // 3️⃣ Controlla limiti utilizzo
    if (promo.maxUsesTotal && promo.usageCount >= promo.maxUsesTotal) continue;
    
    if (promo.maxUsesPerUser && userEmail) {
      const userUsageCount = await prisma.promotionUsage.count({
        where: {
          promotionId: promo.id,
          customerEmail: userEmail
        }
      });
      if (userUsageCount >= promo.maxUsesPerUser) continue;
    }
    
    // 4️⃣ Verifica condizioni
    if (!checkConditions(promo, cart)) continue;
    
    // 5️⃣ Calcola sconto specifico
    const result = calculatePromoDiscount(promo, cart);
    
    if (result.discount > 0 || result.giftProduct) {
      totalDiscount += result.discount;
      
      const promoApplied = {
        id: promo.id,
        name: promo.name,
        type: promo.type,
        discount: result.discount,
        details: result.details
      };
      
      appliedPromotions.push(promoApplied);
      processedPromoIds.add(promo.id);
      
      // Aggiungi regalo se presente
      if (result.giftProduct) {
        giftProducts.push(result.giftProduct);
      }
      
      // 6️⃣ Gestione combinabilità
      const canCombine = promo.combinesWith && promo.combinesWith.length > 0;
      
      if (!canCombine) {
        // Stop: questa promo non è combinabile
        break;
      }
      // Continua solo con promo nella whitelist
      // (filtro già fatto sopra con processedPromoIds)
    }
  }
  
  // 7️⃣ Assicura che sconto non superi subtotal
  const maxDiscount = cart.subtotal;
  if (totalDiscount > maxDiscount) {
    totalDiscount = maxDiscount;
  }
  
  return {
    totalDiscount,
    appliedPromotions,
    giftProducts,
    finalTotal: cart.subtotal - totalDiscount
  };
}

/**
 * ✅ VERIFICA CONDIZIONI PROMO
 */
function checkConditions(promo, cart) {
  const cond = promo.conditions;
  
  // 📊 Quantità prodotti
  if (cond.minQuantity && cart.totalItems < cond.minQuantity) {
    return false;
  }
  if (cond.maxQuantity && cart.totalItems > cond.maxQuantity) {
    return false;
  }
  
  // 💰 Valore carrello
  if (cond.minCartValue && cart.subtotal < cond.minCartValue) {
    return false;
  }
  if (cond.maxCartValue && cart.subtotal > cond.maxCartValue) {
    return false;
  }
  
  // 🏷️ Categorie
  if (cond.categories && cond.categories.length > 0) {
    const cartCategories = cart.items.map(i => i.product.category);
    const hasValidCategory = cond.categories.some(cat => 
      cartCategories.includes(cat)
    );
    if (!hasValidCategory) return false;
  }
  
  // 🎯 Prodotti specifici
  if (cond.products && cond.products.length > 0) {
    const cartProductIds = cart.items.map(i => i.productId);
    
    if (cond.attributes?.mustContainAll) {
      // Devono esserci TUTTI i prodotti specificati
      const hasAllProducts = cond.products.every(pid => 
        cartProductIds.includes(pid)
      );
      if (!hasAllProducts) return false;
    } else {
      // Basta che ce ne sia ALMENO UNO
      const hasAnyProduct = cond.products.some(pid => 
        cartProductIds.includes(pid)
      );
      if (!hasAnyProduct) return false;
    }
  }
  
  // 🎨 Attributi (stessa taglia, colore, etc)
  if (cond.attributes) {
    // Stessa taglia
    if (cond.attributes.sameTaglia) {
      const sizes = cart.items.map(i => i.size);
      const uniqueSizes = new Set(sizes);
      if (uniqueSizes.size > 1) return false;
    }
    
    // Stesso colore
    if (cond.attributes.sameColor) {
      const colors = cart.items.map(i => i.color);
      const uniqueColors = new Set(colors);
      if (uniqueColors.size > 1) return false;
    }
    
    // Stesso prodotto
    if (cond.attributes.sameProduct) {
      const products = cart.items.map(i => i.productId);
      const uniqueProducts = new Set(products);
      if (uniqueProducts.size > 1) return false;
    }
  }
  
  return true;
}

/**
 * 💰 CALCOLA SCONTO SPECIFICO PER TIPO PROMO
 */
function calculatePromoDiscount(promo, cart) {
  switch (promo.type) {
    case 'PERCENTAGE':
      return {
        discount: cart.subtotal * (promo.discountValue / 100),
        details: { type: 'percentage', value: promo.discountValue }
      };
      
    case 'FIXED':
      return {
        discount: Math.min(promo.discountValue, cart.subtotal),
        details: { type: 'fixed', value: promo.discountValue }
      };
      
    case 'PRICE_FIXED':
      // Paga solo X€ (sconto = subtotal - X)
      const discount = Math.max(0, cart.subtotal - promo.discountValue);
      return {
        discount,
        details: { type: 'price_fixed', finalPrice: promo.discountValue }
      };
      
    case 'TIERED':
      return calculateTieredDiscount(promo.discountTiers, cart);
      
    case 'BOGO':
      return calculateBOGODiscount(promo.bogoConfig, cart);
      
    case 'FREE_SHIPPING':
      return {
        discount: cart.shippingCost || 0,
        details: { type: 'free_shipping' }
      };
      
    case 'FREE_GIFT':
      return {
        discount: 0,
        giftProduct: promo.giftProduct,
        details: { type: 'free_gift', giftName: promo.giftProduct?.name }
      };
      
    default:
      return { discount: 0, details: {} };
  }
}

/**
 * 📊 SCONTO PROGRESSIVO/CUMULATIVO
 */
function calculateTieredDiscount(tiers, cart) {
  // Tipo Cumulativo: ogni N prodotti = X€ sconto
  if (tiers.mode === 'cumulative') {
    const groups = Math.floor(cart.totalItems / tiers.perUnit);
    let discount = 0;
    
    if (tiers.type === 'PERCENTAGE') {
      // Ogni gruppo aggiunge % di sconto
      const totalPercentage = groups * tiers.discount;
      const cappedPercentage = Math.min(totalPercentage, tiers.maxDiscount || 100);
      discount = cart.subtotal * (cappedPercentage / 100);
    } else {
      // Ogni gruppo aggiunge sconto fisso
      discount = groups * tiers.discount;
      discount = Math.min(discount, tiers.maxDiscount || Infinity);
    }
    
    return {
      discount,
      details: {
        type: 'cumulative',
        groups,
        perUnit: tiers.perUnit,
        discountPerGroup: tiers.discount
      }
    };
  }
  
  // Tipo Progressivo: raggiungi soglia = sconto totale
  const sortedTiers = [...tiers].sort((a, b) => b.threshold - a.threshold);
  const applicableTier = sortedTiers.find(t => cart.totalItems >= t.threshold);
  
  if (!applicableTier) {
    return { discount: 0, details: {} };
  }
  
  let discount = 0;
  if (applicableTier.type === 'PERCENTAGE') {
    discount = cart.subtotal * (applicableTier.discount / 100);
  } else {
    discount = applicableTier.discount;
  }
  
  return {
    discount,
    details: {
      type: 'tiered',
      threshold: applicableTier.threshold,
      discountValue: applicableTier.discount,
      discountType: applicableTier.type
    }
  };
}

/**
 * 🎁 BOGO (Buy X Get Y)
 */
function calculateBOGODiscount(config, cart) {
  const { buy, get, discountOnGet, applyOnCheapest } = config;
  const totalUnits = buy + get;
  const groups = Math.floor(cart.totalItems / totalUnits);
  
  if (groups === 0) {
    return { discount: 0, details: {} };
  }
  
  // Ordina items per prezzo
  const sortedItems = [...cart.items].sort((a, b) => {
    const priceA = a.unitPrice;
    const priceB = b.unitPrice;
    return applyOnCheapest ? priceA - priceB : priceB - priceA;
  });
  
  let totalDiscount = 0;
  const discountedItems = [];
  
  // Per ogni gruppo completo
  for (let i = 0; i < groups; i++) {
    // Sconto sul prodotto in posizione "buy" (dopo i primi N)
    const targetIndex = i * totalUnits + buy;
    
    if (targetIndex < sortedItems.length) {
      const item = sortedItems[targetIndex];
      const itemDiscount = item.unitPrice * (discountOnGet / 100);
      totalDiscount += itemDiscount;
      
      discountedItems.push({
        productName: item.product.name,
        originalPrice: item.unitPrice,
        discount: itemDiscount
      });
    }
  }
  
  return {
    discount: totalDiscount,
    details: {
      type: 'bogo',
      buy,
      get,
      discountPercent: discountOnGet,
      groups,
      discountedItems
    }
  };
}

/**
 * 🔍 CALCOLA PROGRESSO VERSO PROSSIMA PROMO
 */
function calculateProgress(cart, promo) {
  const cond = promo.conditions;
  let progress = {
    percentage: 0,
    remaining: 0,
    nextThreshold: null,
    message: ''
  };
  
  // Progress per quantità
  if (cond.minQuantity) {
    const current = cart.totalItems;
    const target = cond.minQuantity;
    
    if (current < target) {
      progress.percentage = (current / target) * 100;
      progress.remaining = target - current;
      progress.nextThreshold = target;
      progress.message = `Aggiungi ${progress.remaining} prodotti per sbloccare ${promo.name}`;
    } else {
      progress.percentage = 100;
      progress.remaining = 0;
      progress.message = `✓ ${promo.name} attiva!`;
    }
  }
  
  // Progress per valore carrello
  if (cond.minCartValue) {
    const current = cart.subtotal;
    const target = cond.minCartValue;
    
    if (current < target) {
      progress.percentage = (current / target) * 100;
      progress.remaining = target - current;
      progress.nextThreshold = target;
      progress.message = `Aggiungi €${progress.remaining.toFixed(2)} per sbloccare ${promo.name}`;
    } else {
      progress.percentage = 100;
      progress.remaining = 0;
      progress.message = `✓ ${promo.name} attiva!`;
    }
  }
  
  // Progress per tiered
  if (promo.type === 'TIERED' && Array.isArray(promo.discountTiers)) {
    const current = cart.totalItems;
    const sortedTiers = [...promo.discountTiers].sort((a, b) => a.threshold - b.threshold);
    const nextTier = sortedTiers.find(t => current < t.threshold);
    
    if (nextTier) {
      const prevTier = sortedTiers.find(t => t.threshold <= current);
      const baseThreshold = prevTier ? prevTier.threshold : 0;
      const range = nextTier.threshold - baseThreshold;
      const progressInRange = current - baseThreshold;
      
      progress.percentage = (progressInRange / range) * 100;
      progress.remaining = nextTier.threshold - current;
      progress.nextThreshold = nextTier.threshold;
      progress.message = `Aggiungi ${progress.remaining} prodotti per -${nextTier.discount}${nextTier.type === 'PERCENTAGE' ? '%' : '€'}`;
    } else {
      progress.percentage = 100;
      progress.message = `✓ Massimo sconto raggiunto!`;
    }
  }
  
  return progress;
}

module.exports = {
  calculatePromotions,
  checkConditions,
  calculatePromoDiscount,
  calculateProgress
};
