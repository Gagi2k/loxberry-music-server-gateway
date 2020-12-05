'use strict';

module.exports = class Log {
    log(category, ...msg) {
        this.message("", category, ...msg);
    }

    warn(category, ...msg) {
        this.message("[WARN]", category, ...msg);
    }

    error(category, ...msg) {
        this.message("[ERROR]", category, ...msg);
    }

    message(severity, category, ...msg) {
        if (severity == "")
            category(...msg);
        else
            category(severity, ...msg);
    }
}
