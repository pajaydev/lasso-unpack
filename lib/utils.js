// check node type is MemberExpression or not.
const isMemberExpression = (node) => {
    if (node && node.callee && node.callee.type === 'MemberExpression') {
        return true;
    }
    return false;
};

// check the node has arguments or not.
const hasArguments = (node) => {
    if (node && node.arguments) {
        return true;
    }
    return false;
}

// Extract packageName, version and fileName from given literal if type = "installed".
function extractLiteralFromInstalled(stats, element) {
    let obj = {};
    let arrayLiteral = element.split('/');
    let length = arrayLiteral.length;
    if (length > 0) {
        const index = validIndex(arrayLiteral);
        obj.packageName = arrayLiteral[index].split("$")[0];
        obj.version = arrayLiteral[index].split("$")[1] || '';
        obj.fileName = arrayLiteral[length - 1];
    }
    return obj;
}

// Extract packageName, version and fileName from given literal if type = "def".
function extractLiteralFromDef(stats, element) {
    if (validLiteral(element)) {
        let arrayLiteral = element.value.split('/');
        let length = arrayLiteral.length;
        if (length > 0) {
            const index = validIndex(arrayLiteral);
            stats.setPackageName(arrayLiteral[index].split("$")[0]);
            stats.setVersion(arrayLiteral[index].split("$")[1] || '');
            stats.fileName(arrayLiteral[length - 1]);
        }
    }
    return stats;
}


module.exports = { isMemberExpression, hasArguments, extractLiteralFromInstalled, extractLiteralFromDef };