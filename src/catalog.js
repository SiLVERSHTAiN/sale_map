// src/catalog.js
import fs from "fs";
import path from "path";

export function loadCatalog() {
    const catalogPath = path.resolve(process.cwd(), "docs/products.json");
    const raw = fs.readFileSync(catalogPath, "utf-8");
    const catalog = JSON.parse(raw);

    const productsById = Object.fromEntries(
        (catalog.products || []).map(p => [p.id, p])
    );

    const citiesById = Object.fromEntries(
        (catalog.cities || []).map(c => [c.id, c])
    );

    return { catalog, productsById, citiesById };
}
