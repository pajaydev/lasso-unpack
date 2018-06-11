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

module.exports = { isMemberExpression, hasArguments };