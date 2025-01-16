const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const greenlock = require('greenlock-express');
const app = express();


// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Grundläggande konfiguration
const PORT = process.env.PORT || 3000;
let db = null;
let isDbHealthy = false;

// State cache för prestandaoptimering
const stateCache = {
    data: null,
    timestamp: null,
    validityPeriod: 50 // millisekunder
};

// Databasinitialisering med förbättrad felhantering
async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        db = new sqlite3.Database('videostate.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, async (err) => {
            if (err) {
                console.error('Databasanslutningsfel:', err);
                reject(err);
                return;
            }

            try {
                // Optimera databasens prestanda och stabilitet
                await runAsync('PRAGMA journal_mode = WAL');
                await runAsync('PRAGMA synchronous = NORMAL');
                await runAsync('PRAGMA foreign_keys = ON');
                await runAsync('PRAGMA busy_timeout = 5000');
                
                // Skapa tabellen med nödvändiga fält
                await runAsync(`
                    CREATE TABLE IF NOT EXISTS videoState (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        currentVideo INTEGER DEFAULT 1 CHECK (currentVideo IN (1, 2)),
                        isPlaying BOOLEAN DEFAULT 0 CHECK (isPlaying IN (0, 1)),
                        volume INTEGER DEFAULT 100 CHECK (volume BETWEEN 0 AND 100),
                        currentTime REAL DEFAULT 0 CHECK (currentTime >= 0),
                        last_command TIMESTAMP,
                        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        system_status TEXT DEFAULT 'healthy'
                    )
                `);

                // Initiera med standardvärden om tabellen är tom
                const count = await getAsync('SELECT COUNT(*) as count FROM videoState');
                if (count.count === 0) {
                    await runAsync(`
                        INSERT INTO videoState (
                            id, currentVideo, isPlaying, volume, currentTime, 
                            last_command, system_status
                        ) VALUES (1, 1, 0, 100, 0, CURRENT_TIMESTAMP, 'healthy')
                    `);
                }

                isDbHealthy = true;
                console.log('Databas initierad framgångsrikt');
                resolve();
            } catch (error) {
                console.error('Databasinitiering misslyckades:', error);
                reject(error);
            }
        });
    });
}

// Hjälpfunktioner för databaskommunikation
function runAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function getAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

// GET endpoint för att hämta aktuellt tillstånd
app.get('/getState', async (req, res) => {
    try {
        if (!isDbHealthy) {
            throw new Error('Databasen är inte tillgänglig');
        }

        // Använd cache om den är giltig
        if (stateCache.data && 
            Date.now() - stateCache.timestamp < stateCache.validityPeriod) {
            return res.json(stateCache.data);
        }

        const row = await getAsync('SELECT * FROM videoState WHERE id = 1');
        if (!row) {
            return res.status(404).json({ error: 'Kunde inte hitta tillstånd' });
        }

        const state = {
            currentVideo: row.currentVideo,
            isPlaying: Boolean(row.isPlaying),
            volume: row.volume,
            currentTime: row.currentTime,
            system_status: row.system_status
        };

        stateCache.data = state;
        stateCache.timestamp = Date.now();

        res.json(state);
    } catch (err) {
        console.error('Fel vid hämtning av tillstånd:', err);
        res.status(500).json({ 
            error: 'Databasfel', 
            details: err.message 
        });
    }
});




// POST endpoint för att uppdatera tillstånd
app.post('/updateState', async (req, res) => {
    if (!isDbHealthy) {
        return res.status(503).json({ error: 'Databasen är inte tillgänglig' });
    }

    try {
        const updates = { ...req.body };
        // Ta bort eventuella fält som inte finns i databasen
        delete updates.timestamp;
        delete updates.seek;
        
        // Validera indata
        if (updates.currentVideo !== undefined && ![1, 2].includes(updates.currentVideo)) {
            return res.status(400).json({ error: 'Ogiltigt videoval' });
        }

        if (updates.volume !== undefined && (updates.volume < 0 || updates.volume > 100)) {
            return res.status(400).json({ error: 'Ogiltig volym' });
        }

        if (updates.currentTime !== undefined) {
            const MAX_VIDEO_LENGTH = 7200; // 2 timmar
            updates.currentTime = Math.max(0, Math.min(updates.currentTime, MAX_VIDEO_LENGTH));
        }

        // Specialhantering för språkbyte
        if (updates.currentVideo !== undefined) {
            updates.currentTime = 0;
            updates.isPlaying = true;
        }

        // Bygg uppdateringsförfrågan
        const updateFields = [];
        const values = [];
        Object.entries(updates).forEach(([key, value]) => {
            if (value !== undefined) {
                updateFields.push(`${key} = ?`);
                values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
            }
        });

        if (updateFields.length === 0) {
            return res.status(400).json({ error: 'Inga giltiga uppdateringar' });
        }

        // Lägg till timestamps
        updateFields.push('last_updated = CURRENT_TIMESTAMP');
        if (updates.isPlaying !== undefined) {
            updateFields.push('last_command = CURRENT_TIMESTAMP');
        }

        // Utför uppdateringen
        await runAsync(
            `UPDATE videoState SET ${updateFields.join(', ')} WHERE id = 1`,
            values
        );

        // Rensa cache
        stateCache.data = null;
        stateCache.timestamp = null;

        // Hämta och returnera uppdaterat tillstånd
        const newState = await getAsync('SELECT * FROM videoState WHERE id = 1');
        res.json({
            success: true,
            state: {
                currentVideo: newState.currentVideo,
                isPlaying: Boolean(newState.isPlaying),
                volume: newState.volume,
                currentTime: newState.currentTime,
                system_status: newState.system_status
            }
        });
    } catch (err) {
        console.error('Uppdateringsfel:', err);
        res.status(500).json({ 
            error: 'Uppdatering misslyckades',
            details: err.message
        });
    }
});


// Backend (Node.js)
app.post('/pm2restart', (req, res) => {
    const { exec } = require('child_process');
    exec('pm2 restart gokart-app', (error, stdout, stderr) => {
        if (error) {
            console.error(`Error: ${error}`);
            return res.status(500).json({ error: error.message });
        }
        res.json({ message: 'Successfully restarted' });
    });
});


// Watchdog process - endast övervakning
const WATCHDOG_INTERVAL = 30000; // 30 sekunder

async function watchdogCheck() {
    if (!isDbHealthy) return;

    try {
        const state = await getAsync('SELECT * FROM videoState WHERE id = 1');
        const now = Date.now();
        
        // Kontrollera systemets hälsa
        const lastCommandAge = state.last_command ? 
            now - new Date(state.last_command).getTime() : 0;
        
        let systemStatus = 'healthy';
        let logMessage = null;

        // Analysera systemets tillstånd
        if (lastCommandAge > 300000) { // 5 minuter
            systemStatus = 'warning';
            logMessage = 'Varning: Inget kommando på över 5 minuter';
        }
        
        if (state.system_status !== systemStatus) {
            await runAsync(
                'UPDATE videoState SET system_status = ? WHERE id = 1',
                [systemStatus]
            );
            
            if (logMessage) {
                console.log(logMessage);
            }
        }
    } catch (error) {
        console.error('Watchdog övervakning misslyckades:', error);
    }
    
    setTimeout(watchdogCheck, WATCHDOG_INTERVAL);
}

// Databasövervakning
async function checkDatabaseHealth() {
    try {
        await getAsync('SELECT 1');
        if (!isDbHealthy) {
            console.log('Databasanslutning återupprättad');
            isDbHealthy = true;
        }
    } catch (error) {
        if (isDbHealthy) {
            console.error('Databasanslutning förlorad:', error);
            isDbHealthy = false;
        }
    }
    setTimeout(checkDatabaseHealth, 5000);
}

// Hantering av avstängning
process.on('SIGINT', async () => {
    try {
        if (db) {
            console.log('Stänger databasanslutning...');
            await new Promise((resolve, reject) => {
                db.close(err => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }
    } catch (error) {
        console.error('Fel vid avstängning:', error);
    }
    process.exit(0);
});

app.get('/', (req, res) => {
  const fs = require('fs');
  const files = {
    swe: fs.existsSync('./swe2.webm'),
    eng: fs.existsSync('./eng2.webm')
  };
  res.json(files);
});









let resetRequested = false;
let resetTimer = null;

// Ny funktion för att återställa alla värden till default
async function resetToDefaultValues() {
    console.log('Återställer alla värden till default...');
    await runAsync(`
        UPDATE videoState 
        SET currentVideo = 1,
            isPlaying = 0,
            volume = 100,
            currentTime = 0,
            system_status = 'healthy',
            last_command = CURRENT_TIMESTAMP,
            last_updated = CURRENT_TIMESTAMP 
        WHERE id = 1
    `);
    console.log('Återställning av defaultvärden slutförd');
}

app.post('/triggerReset', async (req, res) => {
    console.log('TriggerReset har aktiverats');
    try {
        // Clear any existing reset timer
        if (resetTimer) {
            console.log('Rensar existerande reset-timer');
            clearTimeout(resetTimer);
        }
        
        // Set reset flag
        resetRequested = true;
        console.log('Reset-flagga satt till:', resetRequested);
        
        // Reset the video state in the database
        console.log('Återställer grundläggande videostate...');
        await runAsync(`
            UPDATE videoState 
            SET isPlaying = 0, 
                currentTime = 0,
                last_updated = CURRENT_TIMESTAMP 
            WHERE id = 1
        `);
        console.log('Grundläggande videostate återställt');

        // Anropa den nya funktionen för att återställa alla värden
        await resetToDefaultValues();
        
        // Clear cache to ensure fresh state
        console.log('Rensar cache...');
        stateCache.data = null;
        stateCache.timestamp = null;
        
        // Set timer to clear reset flag
        console.log('Sätter ny reset-timer...');
        resetTimer = setTimeout(() => {
            resetRequested = false;
            console.log('Reset-flagga återställd till:', resetRequested);
        }, 2000);
        
        console.log('Reset-process slutförd framgångsrikt');
        res.json({ success: true });
    } catch (error) {
        console.error('Reset-fel:', error);
        res.status(500).json({ error: 'Reset failed' });
    }
});



app.get('/checkReset', (req, res) => {
    res.json({ shouldReset: resetRequested });
});










// Starta servern
initializeDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server igång på port ${PORT}`);
            watchdogCheck();
            checkDatabaseHealth();
        });
    })
    .catch(err => {
        console.error('Kunde inte starta servern:', err);
        process.exit(1);
    });

