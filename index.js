import inquirer from 'inquirer';
import { exportDatabase, importDatabase, listBackups } from './db-backup.js';


async function mainMenu() {
    let running = true;

    while (running) {
        const { action } = await inquirer.prompt([
            {
                type: 'select', // <--- Changed from 'list' to 'select'
                name: 'action',
                message: 'What would you like to do?',
                choices: [
                    { name: '1. List all DB backups', value: 'list' },
                    { name: '2. Create a new backup', value: 'export' },
                    { name: '3. Restore DB from an existing backup', value: 'import' },
                    new inquirer.Separator(),
                    { name: 'Exit', value: 'exit' },
                ],
            },
        ]);

        switch (action) {
            case 'list':
                await handleListBackups();
                break;

            case 'export':
                await handleExportDatabase();
                break;

            case 'import':
                await handleImportDatabase();
                break;

            case 'exit':
                console.log('\nGoodbye!');
                running = false;
                break;
        }

        if (running) {
            console.log('\n----------------------------------------\n');
        }
    }
}

async function handleListBackups() {
    const backups = await listBackups();

    if (backups.length === 0) {
        console.log('\n No backups found in the exports folder.');
        return;
    }

    console.log(`\n Found ${backups.length} backup(s):\n`);
    backups.forEach((b, index) => {
        console.log(`  ${index + 1}. DB: ${b.dbName} | Date: ${b.timestamp} | Folder: ${b.folderName}`);
    });
}

async function handleExportDatabase() {
    const { dbName } = await inquirer.prompt([
        {
            type: 'input',
            name: 'dbName',
            message: 'Enter the database name to export:',
            validate: (input) => (input.trim() ? true : 'Database name cannot be empty.'),
        },
    ]);

    console.log('');
    await exportDatabase(dbName.trim());
}

async function handleImportDatabase() {
    const backups = await listBackups();

    if (backups.length === 0) {
        console.log('\n No backups found to restore.');
        return;
    }

    // 1. Select backup using arrow keys
    const { selectedBackupFolder } = await inquirer.prompt([
        {
            type: 'select', // <--- Changed from 'list' to 'select'
            name: 'selectedBackupFolder',
            message: 'Select a backup folder to restore:',
            choices: backups.map((b) => ({
                name: `${b.dbName} (${b.timestamp}) [${b.folderName}]`,
                value: b.folderName,
            })),
        },
    ]);

    // Find selected backup info to offer default DB name
    const selectedBackup = backups.find((b) => b.folderName === selectedBackupFolder);

    // 2. Ask for target DB name (defaults to original DB name)
    const { targetDbName } = await inquirer.prompt([
        {
            type: 'input',
            name: 'targetDbName',
            message: 'Enter the target database name to restore into:',
            default: selectedBackup?.dbName || 'restored_db',
            validate: (input) => (input.trim() ? true : 'Database name cannot be empty.'),
        },
    ]);

    console.log('');
    await importDatabase(targetDbName.trim(), selectedBackupFolder);
}

mainMenu();