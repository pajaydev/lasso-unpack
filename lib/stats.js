
class Stats {
    constructor(options) {
        this.type = '';
        this.fileName = '';
        this.packageName = '';
        this.content = '';
        this.version = '';
        this.size = '';
        this.start = 0;
        this.end = 0;
    }

    setType(type) {
        this.type = type;
    }

    setFileName(fileName) {
        this.fileName = fileName;
    }

    setPackageName(packageName) {
        this.packageName = packageName;
    }

    setStart(start) {
        this.start = start;
    }

    setEnd(end) {
        this.end = end;
    }
}

module.exports = Stats;