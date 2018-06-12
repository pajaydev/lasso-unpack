const acorn = require('acorn');
const fs = require('fs');
const walk = require('acorn/dist/walk');
const Stats = require('./stats');
const getArguments = require('./utils').getArguments;
const isMemberExpression = require('./utils').isMemberExpression;
const extractLiteralFromInstalled = require('./utils').extractLiteralFromInstalled;
const extractLiteralFromDef = require('./utils').extractLiteralFromDef;
const isValidFunctionExpression = require('./utils').isValidFunctionExpression;

function parseLassoBundle() {
    const fileContent = fs.readFileSync(__dirname + '/build.js', 'utf8');
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
                stats.setStart(node.start);
                stats.setEnd(node.end);
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
    return { walkState };
};

// extract literal from AST tree.
function extractLiterals(stats, args) {
    if (stats.getType() != null && stats.getType() === "installed") {
        extractLiteralFromInstalled(stats, args);
    }

    if (stats.getType() != null && stats.getType() === "def") {
        extractLiteralFromDef(stats, args[0]);
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

parseLassoBundle();
module.exports = { parseLassoBundle };