/** True after Mongo, auth, and paper-live boot tasks finish. */
let platformReady = false;

function setPlatformReady(value) {
  platformReady = Boolean(value);
}

function isPlatformReady() {
  return platformReady;
}

module.exports = { setPlatformReady, isPlatformReady };
