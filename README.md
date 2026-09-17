# PPIC Warehouse Control Tower

Dashboard monitoring kesehatan inventory & PO, live-sync dari Google Sheets
(sheet "Monitoring PO 2.0", via Publish to Web CSV).

## Menjalankan di lokal
```
npm install
npm run dev
```

## Deploy
Push repo ini ke GitHub, lalu import ke Vercel (Framework preset: Vite).
Tidak perlu environment variable -- link CSV publik sudah ada di kode.

## Mengganti sumber data
Edit konstanta `CSV_URL` di `src/PPICControlTower.jsx` kalau link publish-to-web
berubah (misal setelah re-publish di Google Sheets).
