const acorn = require('acorn');
const fs = require('fs');
const walk = require('acorn/dist/walk');
const Stats = require('./stats');
const getArguments = require('./utils').getArguments;
const isMemberExpression = require('./utils').isMemberExpression;
const extractLiteralFromInstalled = require('./utils').extractLiteralFromInstalled;
const extractLiteralFromDef = require('./utils').extractLiteralFromDef;

function parseLassoBundle() {
    const content = fs.readFileSync(__dirname + '/build.js', 'utf8');
    const ast = acorn.parse(content, {
        sourceType: 'script'
    });
    const stats = new Stats();
    const walkState = [];
    console.log(walkState);
    if (ast.body.length === 0) return "Empty File"
    walk.recursive(
        ast,
        walkState,
        {
            CallExpression(node, state, c) {
                stats.setStart(node.start);
                stats.setEnd(node.end);
                if (isMemberExpression(node)) {
                    let memberNode = node.callee;
                    if (memberNode.property && memberNode.property.type === "Identifier") {
                        stats.setType(memberNode.property.name);
                    }
                }
                console.log(node);
                const args = getArguments(node);
                if (args.length > 0) {
                    extractLiterals(stats, args);
                }
                if (stats.getType() === "def") {
                    extractContent(node);
                }
                console.log(stats);
            },
        });
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

function extractContent(node) {

}

parseLassoBundle();
module.exports = { parseLassoBundle };