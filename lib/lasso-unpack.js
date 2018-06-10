const acorn = require('acorn');
const fs = require('fs');
const walk = require('acorn/dist/walk');

function parseLassoBundle() {
    const content = fs.readFileSync(__dirname + 'lib/build.js', 'utf8');
    const ast = acorn.parse(content, {
        sourceType: 'script'
    });
}

module.exports = { parseLassoBundle };