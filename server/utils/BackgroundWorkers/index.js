const path = require("path");
const Graceful = require("@ladjs/graceful");
const Bree = require("bree");
const { getVectorDbClass } = require("../helpers");

class BackgroundService {
  name = "BackgroundWorkerService";
  static _instance = null;
  #root =
    process.env.NODE_ENV === "development"
      ? path.resolve(__dirname, "../../jobs")
      : // Since we bundle the jobs with esbuild into the jobs directory in Resources on desktop
        // and it is in the same folder as server.js we can just reference the folder relative ./
        path.resolve(__dirname, "./jobs");

  constructor() {
    if (BackgroundService._instance) {
      this.#log("SINGLETON LOCK: Using existing BackgroundService.");
      return BackgroundService._instance;
    }

    this.logger = this.getLogger();
    BackgroundService._instance = this;
  }

  #log(text, ...args) {
    console.log(`\x1b[36m[${this.name}]\x1b[0m ${text}`, ...args);
  }

  async boot() {
    const { DocumentSyncQueue } = require("../../models/documentSyncQueue");
    if (!(await DocumentSyncQueue.enabled())) {
      this.#log("Feature is not enabled and will not be started.");
      return;
    }

    this.#log("Starting...");
    this.bree = new Bree({
      logger: this.logger,
      root: this.#root,
      jobs: this.jobs(),
      errorHandler: this.onError,
      workerMessageHandler: this.onWorkerMessageHandler,
    });
    this.graceful = new Graceful({ brees: [this.bree], logger: this.logger });
    this.graceful.listen();
    this.bree.start();
    this.#log("Service started");

    if (process.platform === "win32" && process.env.VECTOR_DB === "lancedb") {
      this.#log(
        "Need main process to bind to lance to prevent lockout on worker for windows."
      );
      this.#log(
        `LanceDB currently has ${await getVectorDbClass().totalVectors()} vectors`
      );
    }
  }

  async stop() {
    this.#log("Stopping...");
    if (!!this.graceful && !!this.bree) this.graceful.stopBree(this.bree, 0);
    this.bree = null;
    this.graceful = null;
    this.#log("Service stopped");
  }

  jobs() {
    return [
      // Job for auto-sync of documents
      // https://github.com/breejs/bree
      {
        name: "sync-watched-documents",
        timeout: "1min", // Wait 60s to check job on boot to make sure there are no pending jobs since last app close.
        interval: "1hr",
      },
    ];
  }

  getLogger() {
    const { format, createLogger, transports } = require("winston");
    return new createLogger({
      level: "info",
      format: format.combine(
        format.colorize(),
        format.printf(({ level, message, service }) => {
          return `\x1b[36m[${service}]\x1b[0m ${level}: ${message}`;
        })
      ),
      defaultMeta: { service: this.name },
      transports: [new transports.Console()],
    });
  }

  onError(error, _workerMetadata) {
    this.logger.error(`[${error.name}]: ${error.message}`);
  }

  onWorkerMessageHandler(message, _workerMetadata) {
    this.logger.info(`[${message.name}]: ${message.message}`);
  }
}

module.exports.BackgroundService = BackgroundService;
