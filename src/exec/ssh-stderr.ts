import { Transform } from 'node:stream';

// OpenSSH already falls back to a fresh authenticated connection for these
// mux races. Suppress only their diagnostics; never retry/replay a job here.
export function sshStderr() {
  let pending = Buffer.alloc(0);
  let continued = false;
  const benign = (line: Buffer) => /^(?:mux_client_request_session: session request failed: Session open refused by peer|ControlSocket .+ already exists, disabling multiplexing)\r?\n?$/.test(line.toString());
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      pending = Buffer.concat([pending, chunk]);
      let end: number;
      while ((end = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, end + 1);
        if (continued || !benign(line)) this.push(line);
        continued = false;
        pending = pending.subarray(end + 1);
      }
      // Keep long/non-line-oriented diagnostics streaming with bounded storage.
      if (pending.length > 4096) {
        this.push(pending); pending = Buffer.alloc(0); continued = true;
      }
      done();
    },
    flush(done) {
      if (continued || !benign(pending)) this.push(pending);
      done();
    },
  });
}
