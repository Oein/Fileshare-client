import EventEmitter from "events";
import { close, open, read, readdirSync, statSync } from "fs";
import { join, sep } from "path";
import axios from "axios";

const log = true;

const SERVER_URL = "http://localhost:4000";

class UploadInstance {
  basePath: string = "";
  uploadThreads = 32;

  allfilescount() {
    const queue = [""];
    let count = 0;

    while (queue.length > 0) {
      const currentPath = queue.shift();
      if (undefined == currentPath) continue;
      const isFile = statSync(this.toRealPath(currentPath)).isFile();

      if (isFile) {
        count++;
        continue;
      }

      const files: string[] = readdirSync(this.toRealPath(currentPath));
      for (const file of files) {
        queue.push(join(currentPath, file));
      }
    }

    return count;
  }

  bytesToSize(bytes: number) {
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    let sizeIndex = 0;
    while (bytes > 1024 && sizeIndex + 1 < sizes.length) {
      bytes = bytes / 1024;
      sizeIndex++;
    }
    return `${Math.ceil(bytes)} ${sizes[sizeIndex]}`;
  }

  toRealPath(relativePath: string) {
    return join(this.basePath, relativePath);
  }

  allocFile(relativePath: string) {
    const tryAlloc: () => Promise<string> = async () => {
      try {
        const res = await axios.post(SERVER_URL + "/alloc", {
          relativePath,
        });
        return res.data as string;
      } catch (e) {
        return await tryAlloc();
      }
    };
    return tryAlloc();
  }

  uploadFile(relativePath: string, threadName?: string) {
    const threadid = Math.random().toString(36).substring(3, 5);
    const threadname = threadName || `[${threadid}]`;
    return new Promise<void>(async (resolve, reject) => {
      const uuidV4 = await this.allocFile(relativePath);

      const filename = relativePath.split(sep).pop();
      if (log) console.log(threadname, `Uploading ${filename}`);
      const chunkSize = 1024 * 1024 * 32; // 8MB
      let chunkIndex = 0;

      const chunksCount = Math.ceil(
        statSync(this.toRealPath(relativePath)).size / chunkSize
      );

      open(this.toRealPath(relativePath), "r", (err, fd) => {
        const buffer = Buffer.alloc(chunkSize);
        const readNextChunk = () => {
          read(fd, buffer, 0, chunkSize, null, async (err, nread) => {
            if (err) return reject(err);

            if (nread === 0) {
              // done reading file, do any necessary finalization steps
              close(fd, async function (err) {
                if (err) return reject(err);
                const tryFinalize = async () => {
                  try {
                    await axios.post(SERVER_URL + "/finalize", {
                      id: uuidV4,
                    });
                  } catch (e) {
                    await tryFinalize();
                  }
                };
                await tryFinalize();

                resolve();
              });
              return;
            }

            var data: any;
            if (nread < chunkSize) data = buffer.slice(0, nread);
            else data = buffer;

            // upload data to the API
            if (log)
              console.log(
                threadname,
                `\tUpload chunk ${chunkIndex}\t/${chunksCount} - ${this.bytesToSize(
                  nread
                )}`
              );
            const tryUpload = async () => {
              try {
                await axios.post(SERVER_URL + "/upload", {
                  id: uuidV4,
                  chunkIndex,
                  data: [...data].map((x) => String.fromCharCode(x)).join(""),
                });
              } catch (e) {
                await tryUpload();
              }
            };
            try {
              await tryUpload();
            } catch (e) {}
            chunkIndex++;

            // read the next chunk
            readNextChunk();
          });
        };

        readNextChunk();
      });
    });
  }

  async processBFS() {
    let allfilescount = this.allfilescount();
    const queue = [""];
    let currentThread = 0;

    const emit = new EventEmitter();

    const updateThreadCount = (count: number) => {
      currentThread = count;
      //   console.log("Thread count", currentThread);
      emit.emit("threadCount", currentThread);
    };

    const waitThread = () => {
      return new Promise<void>((resolve) => {
        if (currentThread < this.uploadThreads) return resolve();
        // console.log("Wait for thread");
        emit.on("threadCount", (count) => {
          //   console.log(count, this.uploadThreads);
          if (count < this.uploadThreads) {
            resolve();
          }
        });
      });
    };

    let cnt = 0;
    const processFile = async (relativePath: string) => {
      cnt++;
      const mcnt = cnt + 0;
      console.log(`Uploading (${cnt}\t/${allfilescount})`);
      updateThreadCount(currentThread + 1);
      await this.uploadFile(relativePath, `[${mcnt}]`);
      updateThreadCount(currentThread - 1);
    };

    // console.log(queue);
    while (queue.length > 0) {
      const currentPath = queue.shift();
      if (undefined == currentPath) continue;
      const isFile = statSync(this.toRealPath(currentPath)).isFile();

      await waitThread();
      //   console.log(currentPath, "WA");
      if (isFile) {
        processFile(currentPath);
        continue;
      }

      const files: string[] = readdirSync(this.toRealPath(currentPath));
      //   console.log(files);
      for (const file of files) {
        queue.push(join(currentPath, file));
      }

      //   console.log(queue);
    }
  }

  async upload(basePath: string) {
    process.stdin.resume();
    this.basePath = basePath;
    const isFile = statSync(this.toRealPath("")).isFile();
    if (isFile) await this.uploadFile("");
    else await this.processBFS();
    process.stdin.pause();
  }
}

(async () => {
  const instance = new UploadInstance();
  await instance.upload(
    "/Users/oein/oein/Pjs/NodeJS/Fileshare/electron/node_modules"
  );
})();
