
class Stats {
    constructor(options) {
        this.type = '';
        this.fileName = '';
        this.packageName = '';
        this.content = '';
        this.version = '';
        this.size = '';
        this.gzipSize = '';
        this.brotiSize = '';
        this.path = '';
    }

    setType(type) {
        this.type = type;
    }

    getType() {
        return this.type;
    }

    setPath(path) {
        this.path = path;
    }

    getPath() {
        return this.path;
    }

    setSize(size) {
        this.size = size;
    }

    setFileName(fileName) {
        this.fileName = fileName;
    }

    setPackageName(packageName) {
        this.packageName = packageName;
    }

    setVersion(version) {
        this.version = version;
    }

    setContent(content) {
        this.content = content;
    }

    setGzipSize(size) {
        this.gzipSize = size;
    }

    setBrotiSize(size) {
        this.brotiSize = size;
    }
}

module.exports = Stats;