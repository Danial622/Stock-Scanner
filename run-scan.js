// run-scan.js
'use strict';
const fs = require('fs');
const path = require('path');
const sc = require('./tse-scanner');

(async () => {
  console.log("Starting TSE Scan...");
  try {
    const result = await sc.executeScan();
    if (!result) {
      console.error("Scan completed but returned no data.");
      process.exit(1);
    }
    // tse-scanner.js automatically saves to daily_signals.json.
    // We also save it as signals.json so the Cloudflare frontend can read it.
    const outPath = path.join(__dirname, 'signals.json');
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`✅ Scan successful. Saved ${result.data.length} signals to signals.json`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Scan failed:", error.message);
    process.exit(1);
  }
})();
