// check node type is MemberExpression or not.
const isMemberExpression = (node) => {
    if (node && node.callee && node.callee.type === 'MemberExpression') {
        return true;
    }
    return false;
};

// get Arguments from the AST tree.
function getArguments(node) {
    if (node && node.arguments && node.arguments.length > 0) {
        return node.arguments;
    }
    return [];
}

// Extract packageName, version and fileName from given literal if type = "installed".
function extractLiteralFromInstalled(stats, element) {
    console.log("insdide dededadsd");
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

// check Literal is valid or not.
function validLiteral(node) {
    if (node && node.type === "Literal" && typeof node.value === 'string') {
        return true;
    }
    return false;
}

function validIndex(array) {

    for (let i = 0; i < array.length; i++) {
        if (array[i].includes("$")) {
            return i;
            break;
        }
    }
    return 0;
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
            stats.setFileName(arrayLiteral.splice(index + 1, length).join('/'));
        }
    }
    return stats;
}

function extractLiteralFromMain(stats, element) {
    if (element.value && element.value != '') {
        let arrayOfValues = element.value.split('/');
        if (arrayOfValues.length > 0) {
            let packageName = arrayOfValues[0] == '' ? arrayOfValues[1] : arrayOfValues[0];
            // stats.setPackageName(packageName);
            let fileName = element.value.replace(packageName + '/', '');
            stats.setPackageName(packageName.split("$")[0]);
            stats.setVersion(packageName.split("$")[1] || '');
            stats.setFileName(fileName);
        }
    }
    return stats;

}

function extractLiteralFromBuiltin(stats, packageName, fileName) {
    stats.setPackageName(packageName);
    stats.setFileName(fileName);
    return stats;
}

// check function expression contains body or not.
function isValidFunctionExpression(node) {
    if (node && node.type === "FunctionExpression" && node.body) {
        return true;
    }
    return false;
}

// check valid function expression or not.
function isFunctionExpression(node) {
    if (node && node.callee && node.callee.type === 'FunctionExpression') {
        return true;
    }
    return false;
}


module.exports = {
    isMemberExpression,
    getArguments,
    extractLiteralFromInstalled,
    extractLiteralFromDef,
    extractLiteralFromMain,
    extractLiteralFromBuiltin,
    isValidFunctionExpression,
    isFunctionExpression
};