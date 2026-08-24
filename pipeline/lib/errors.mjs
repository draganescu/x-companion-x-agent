export class PipelineError extends Error {
    constructor(code, message, hint = '', extra = {}) {
        super(message);
        this.name = 'PipelineError';
        this.code = code;
        this.hint = hint;
        this.extra = extra;
    }
}
