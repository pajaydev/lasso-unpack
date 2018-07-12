const acorn = require('acorn');
const fs = require('fs');
const path = require('path');
const walk = require('acorn/dist/walk');
const Stats = require('./stats');
const getArguments = require('./utils').getArguments;
const isMemberExpression = require('./utils').isMemberExpression;
const extractLiteralFromInstalled = require('./utils').extractLiteralFromInstalled;
const extractLiteralFromDef = require('./utils').extractLiteralFromDef;
const extractLiteralFromMain = require('./utils').extractLiteralFromMain;
const extractLiteralFromBuiltin = require('./utils').extractLiteralFromBuiltin;
const isValidFunctionExpression = require('./utils').isValidFunctionExpression;
const isFunctionExpression = require('./utils').isFunctionExpression;

function parseLassoBundle(fileName) {
    const fileContent = fs.readFileSync(path.resolve(fileName), 'utf8');
    const ast = acorn.parse(fileContent, {
        sourceType: 'script'
    });

    const walkState = [];
    if (ast.body.length === 0) return "Empty File"
    walk.recursive(
        ast,
        walkState,
        {
            CallExpression(node, state, c) {
                const stats = new Stats();
                if (node.start && node.end) {
                    stats.setSize(node.end - node.start);
                } else {
                    stats.setSize(0);
                }
                if (isFunctionExpression(node)) {
                    stats.setPackageName("module.js");
                    stats.setFileName("module.js");
                    stats.setPath("/module.js");
                }
                if (isMemberExpression(node)) {
                    let memberNode = node.callee;
                    if (memberNode.property && memberNode.property.type === "Identifier") {
                        stats.setType(memberNode.property.name);
                    }
                }
                const args = getArguments(node);
                if (args.length > 0) {
                    extractLiterals(stats, args);
                }
                if (stats.getType() === "def") {
                    extractContent(fileContent, stats, args[1]);
                }
                walkState.push(stats);
            },
        });
    const manifestPath = path.resolve(options.input, 'lasso-stats.json');
    fs.writeFileSync(manifestPath, JSON.stringify(walkState, null, 2));
    return { walkState };
};
let options = {
    input: 'lib'
}

// extract literal from AST tree.
function extractLiterals(stats, args) {
    if (stats.getType() != null && (stats.getType() === "installed" || stats.getType() === "builtin")) {
        extractLiteralFromInstalled(stats, args);
    }

    if (stats.getType() != null && stats.getType() === "def") {
        extractLiteralFromDef(stats, args[0]);
    }

    if (stats.getType() != null && (stats.getType() === "main" || stats.getType() === "remap")) {
        extractLiteralFromMain(stats, args[0]);
    }
}

function extractContent(fileContent, stats, node) {
    if (isValidFunctionExpression(node)) {
        let body = node.body;
        let start = body.start || 0;
        let end = body.end || 0;
        if (!body) body = [];
        stats.setContent(fileContent.slice(start, end));
    }
}

module.exports = parseLassoBundle;