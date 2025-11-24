const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Crea prodotti
  await prisma.product.create({
    data: {
      name: 'Hoody',
      slug: 'hoody',
      basePrice: 49.00,
      launchPrice: 39.00,
      colors: ['Military Green'],
      sizes: ['S', 'M', 'L', 'XL', 'XXL'],
      isActive: true
    }
  });

  await prisma.product.create({
    data: {
      name: 'Girocollo',
      slug: 'girocollo',
      basePrice: 44.00,
      launchPrice: 34.00,
      colors: ['Blue Nesio', 'Dark Heather', 'Maroon', 'Dark Chocolate'],
      sizes: ['S', 'M', 'L', 'XL', 'XXL'],
      isActive: true
    }
  });

  // Crea configurazioni
  await prisma.config.create({
    data: {
      key: 'bundle_discount',
      value: { percentage: 5 },
      description: 'Sconto per 2+ felpe stessa taglia'
    }
  });

  await prisma.config.create({
    data: {
      key: 'launch_prices_active',
      value: { active: true },
      description: 'Attiva prezzi di lancio'
    }
  });

  console.log('✅ Database seeded!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });