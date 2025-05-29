import dbManager from './database.js';

async function main() {
  const command = process.argv[2];
  
  try {
    await dbManager.initialize();
    
    // eslint-disable-next-line no-console
    console.log('Database initialized');
    
    switch (command) {
      case 'migrate':
        await dbManager.runMigrations();
        // eslint-disable-next-line no-console
        console.log('Migrations completed successfully');
        break;
      case 'rollback':
        await dbManager.rollbackLastMigration();
        // eslint-disable-next-line no-console
        console.log('Rollback completed successfully');
        break;
      default:
        // eslint-disable-next-line no-console
        console.error('Invalid command. Use "migrate" or "rollback"');
        process.exit(1);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await dbManager.close();
    // eslint-disable-next-line no-console
    console.log('Database connection closed');
  }
}

main(); 