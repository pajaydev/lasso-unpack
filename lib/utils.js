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
    if (element.length === 0) return stats;
    let value = "";
    if (validLiteral(element[0])) {
        value = element[0].value;
        // let array = value.split('$');
        // if (array.length == 0) {
        //     stats.setPackageName(value);
        // } else {
        //     stats.setPackageName(array[0]);
        //     stats.setPackageVersion(array[1]);
        // }
        stats.setPackageName(value);
    }
    if (validLiteral(element[1])) {
        value = element[1].value;
        stats.setFileName(value);
    }
    if (validLiteral(element[2])) {
        value = element[2].value;
        stats.setVersion(value);
    }
    return stats;
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
            stats.setFileName(arrayLiteral[length - 1]);
        }
    }
    return stats;
}


module.exports = { isMemberExpression, hasArguments, extractLiteralFromInstalled, extractLiteralFromDef };