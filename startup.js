// startup.js
const fs = require('fs');
const path = require('path');

// Funktion för att ta bort en fil med felhantering
function removeFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`Successfully removed: ${filePath}`);
            return true;
        }
        return false;
    } catch (error) {
        console.error(`Error removing ${filePath}:`, error);
        return false;
    }
}

// Funktion för att rensa alla databasfiler
async function cleanupDatabases() {
    console.log('Starting database cleanup...');
    
    const databasesToRemove = [
        'videostate.db',
        'videostate.db-shm',
        'videostate.db-wal'
    ];

    // Ta bort varje databasfil
    for (const db of databasesToRemove) {
        const filePath = path.join(__dirname, db);
        removeFile(filePath);
    }

    // Vänta 1 sekund
    console.log('Waiting 1 second before starting app...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('Starting application...');
    require('./app.js');
}

// Kör cleanup och starta appen
cleanupDatabases();