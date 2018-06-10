class Stats {
    constructor(options) {
        this.fileName = '';
        this.packageName = '';
        this.content = '';
        this.version = '';
        this.size = '';
    }

    setFileName(fileName) {
        this.fileName = fileName;
    }

    setPackageName(packageName) {
        this.packageName = packageName;
    }
}

module.exports = Stats;