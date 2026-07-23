import 'dotenv/config';
import { MongoClient, BSON } from 'mongodb';
import fs from 'fs/promises';
import path from 'path';
import cliProgress from 'cli-progress';

const MONGO_URI = process.env.MONGO_URI;
const EXPORT_BASE_DIR = './exports';

function getFolderName(dbName) {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  const timestamp = `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
  return `${dbName}_${timestamp}`;
}

/**
 * EXPORT: Uses BSON.EJSON to preserve ObjectIds, Dates, and Nested JSON structures.
 */
export async function exportDatabase(dbName, outputDir = EXPORT_BASE_DIR) {
  if (!MONGO_URI) {
    throw new Error('MONGO_URI is not defined in your .env file');
  }

  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    console.log('[Export] Connected to MongoDB...');

    const db = client.db(dbName);
    const collections = await db.listCollections().toArray();

    // Filter out system collections
    const validCollections = collections.filter((c) => !c.name.startsWith('system.'));

    if (validCollections.length === 0) {
      console.log(`[Export] No exportable collections found in database "${dbName}".`);
      return;
    }

    console.log('[Export] Calculating collection stats...');
    let totalDocs = 0;
    const collectionCounts = {};

    for (const colInfo of validCollections) {
      const count = await db.collection(colInfo.name).countDocuments();
      collectionCounts[colInfo.name] = count;
      totalDocs += count;
    }

    const folderName = getFolderName(dbName);
    const targetPath = path.join(outputDir, folderName);
    await fs.mkdir(targetPath, { recursive: true });

    console.log(`\nExporting "${dbName}" (${totalDocs} documents across ${validCollections.length} collections)\n`);

    for (const colInfo of validCollections) {
      const colName = colInfo.name;
      const colTotalDocs = collectionCounts[colName];
      const collection = db.collection(colName);
      const filePath = path.join(targetPath, `${colName}.json`);

      const colLabel = colName.padEnd(20, ' ').substring(0, 20);

      const progressBar = new cliProgress.SingleBar({
        format: `${colLabel} [{bar}] {percentage}% | {value}/{total} docs`,
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
        clearOnComplete: false,
      });

      if (colTotalDocs === 0) {
        progressBar.start(1, 1);
        progressBar.stop();
        await fs.writeFile(filePath, '[]', 'utf-8');
        console.log(`  ✓ Exported ${colName} (0 documents)`);
        continue;
      }

      progressBar.start(colTotalDocs, 0);

      const cursor = collection.find({});
      const data = [];
      let colProcessedDocs = 0;

      while (await cursor.hasNext()) {
        const doc = await cursor.next();
        data.push(doc);
        colProcessedDocs++;
        progressBar.update(colProcessedDocs);
      }

      // EJSON.stringify preserves MongoDB types ($oid, $date, nested objects, etc.)
      const serializedData = BSON.EJSON.stringify(data, null, 2, { relaxed: false });
      await fs.writeFile(filePath, serializedData, 'utf-8');

      progressBar.stop();
      console.log(`  ✓ Exported ${colName} (${data.length} documents)`);
    }

    console.log(`\n✓ [Export Complete] Saved to: ${targetPath}\n`);
  } catch (error) {
    console.error('[Export Error]:', error);
  } finally {
    await client.close();
  }
}

/**
 * LIST BACKUPS
 */
export async function listBackups(baseDir = EXPORT_BASE_DIR) {
  try {
    try {
      await fs.access(baseDir);
    } catch {
      return [];
    }

    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

    const backups = [];

    for (const folderName of folders) {
      const match = folderName.match(/^(.+)_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})$/);

      if (match) {
        const [, dbName, datePart, timePart] = match;
        const formattedTime = timePart.replace(/-/g, ':');
        const isoString = `${datePart}T${formattedTime}`;
        const parsedDate = new Date(isoString);

        backups.push({
          folderName,
          dbName,
          timestamp: `${datePart} ${formattedTime}`,
          date: parsedDate,
        });
      } else {
        const stats = await fs.stat(path.join(baseDir, folderName));
        backups.push({
          folderName,
          dbName: 'unknown',
          timestamp: stats.mtime.toLocaleString(),
          date: stats.mtime,
        });
      }
    }

    backups.sort((a, b) => b.date - a.date);
    return backups;
  } catch (error) {
    console.error('[List Error]:', error);
    return [];
  }
}

/**
 * IMPORT: Uses BSON.EJSON to reconstruct true ObjectIds, Dates, and Nested JSON.
 */
export async function importDatabase(dbName, sourceFolderName, baseDir = EXPORT_BASE_DIR) {
  if (!MONGO_URI) {
    throw new Error('MONGO_URI is not defined in your .env file');
  }

  const client = new MongoClient(MONGO_URI);

  try {
    const sourcePath = path.join(baseDir, sourceFolderName);

    try {
      await fs.access(sourcePath);
    } catch {
      throw new Error(`Export folder does not exist: ${sourcePath}`);
    }

    await client.connect();
    console.log('[Import] Connected to MongoDB...');

    const db = client.db(dbName);
    const files = await fs.readdir(sourcePath);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    if (jsonFiles.length === 0) {
      console.log(`[Import] No JSON files found in ${sourcePath}`);
      return;
    }

    console.log(`\n[Import] Importing files into database "${dbName}"...\n`);

    for (const file of jsonFiles) {
      const collectionName = path.basename(file, '.json');
      const filePath = path.join(sourcePath, file);

      const rawData = await fs.readFile(filePath, 'utf-8');

      // EJSON.parse restores real ObjectIds, ISODates, and deep object structures
      const documents = BSON.EJSON.parse(rawData, { relaxed: false });

      if (!Array.isArray(documents) || documents.length === 0) {
        console.log(`  ↷ Skipped ${collectionName} (empty or invalid array)`);
        continue;
      }

      const colLabel = collectionName.padEnd(20, ' ').substring(0, 20);

      const progressBar = new cliProgress.SingleBar({
        format: `${colLabel} [{bar}] {percentage}% | {value}/{total} docs`,
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
        clearOnComplete: false,
      });

      progressBar.start(documents.length, 0);

      const collection = db.collection(collectionName);

      const BATCH_SIZE = 100;
      let insertedCount = 0;

      for (let i = 0; i < documents.length; i += BATCH_SIZE) {
        const batch = documents.slice(i, i + BATCH_SIZE);
        await collection.insertMany(batch);
        insertedCount += batch.length;
        progressBar.update(insertedCount);
      }

      progressBar.stop();
      console.log(`  ✓ Imported ${collectionName} (${insertedCount} documents)`);
    }

    console.log('\n✓ [Import Complete]\n');
  } catch (error) {
    console.error('[Import Error]:', error);
  } finally {
    await client.close();
  }
}