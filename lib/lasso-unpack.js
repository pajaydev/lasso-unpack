const acorn = require('acorn');
const fs = require('fs');
const walk = require('acorn/dist/walk');

function parseLassoBundle() {
    const content = fs.readFileSync(__dirname + 'lib/build.js', 'utf8');
    const ast = acorn.parse(content, {
        sourceType: 'script'
    });
}

function extractLiterals(stats, args) {
    if (stats.getType() != null && stats.getType() === "installed") {
        extractLiteralFromInstalled(stats, args);
    }

    if (stats.getType() != null && stats.getType() === "def") {
        extractLiteralFromDef(stats, args[0]);
    }
}

module.exports = { parseLassoBundle };