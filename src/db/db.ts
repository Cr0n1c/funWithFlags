import dbManager from './database.js';

async function main() {
  const command = process.argv[2];
  
  try {
    await dbManager.initialize();
    
    switch (command) {
      case 'migrate':
        await dbManager.runMigrations();
        console.log('Migrations completed successfully');
        break;
      case 'rollback':
        await dbManager.rollbackLastMigration();
        console.log('Rollback completed successfully');
        break;
      default:
        console.error('Invalid command. Use "migrate" or "rollback"');
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await dbManager.close();
  }
}

main(); 