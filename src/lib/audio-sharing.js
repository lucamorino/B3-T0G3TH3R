// Audio sharing between phones, peer to peer over WebRTC, after the No-Input
// Network Audiosystem of NINA_B3-H4RSH:
//
//   send:    source ──► MediaStreamDestination ──► WebRTC track ──► peer
//   receive: peer ──► WebRTC track ──► MediaStreamAudioSourceNode ──► destination
//
// In the player, `source` is the output of the RNBO device and `destination` its
// audio input: a phone processes the sound the others send it, and its own
// output goes on to the phones it sends to.
//
// Who sends to whom is set in the controller's routing matrix (the `routing`
// state). Each route is one RTCPeerConnection, opened by the sending phone; the
// server relays the signaling messages between phones (see server.js).

// STUN helps across networks; on a local network without internet access the
// phones still find each other through their local (host) candidates.
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
// Delay (ms) before opening a failed route again.
const RETRY_DELAY = 3000;

export default async function setupAudioSharing({ client, audioContext, index, source, destination, user }) {
  const mediaStreamDestination = audioContext.createMediaStreamDestination();
  source.connect(mediaStreamDestination);

  const peerConnections = new Map(); // `${from}-${to}` -> RTCPeerConnection
  const remoteSources = new Map(); // key -> { node, audioElement }
  // ICE candidates received before the connection they belong to has its remote
  // description: they cannot be added yet.
  const pendingCandidates = new Map(); // key -> RTCIceCandidateInit[]
  // Signaling messages are handled one after the other for each connection, as
  // most of the steps are asynchronous.
  const signalQueues = new Map(); // key -> Promise

  let connections = [];
  let retryTimeout = null;

  const pcKey = (from, to) => `${from}-${to}`;
  const sendSignal = (to, payload) => client.socket.send('webrtc:signal', { to, payload });

  // Publish the players this phone currently reaches, for the controller.
  function reportConnectedTo() {
    const peers = [];
    for (const [key, pc] of peerConnections) {
      const [from, to] = key.split('-').map(Number);
      if (from === index && pc.connectionState === 'connected') peers.push(to);
    }
    peers.sort((a, b) => a - b);
    const current = user.get('connectedTo') ?? [];
    if (peers.join(',') !== current.join(',')) user.set({ connectedTo: peers });
  }

  function closePeerConnection(key) {
    const pc = peerConnections.get(key);
    if (pc) {
      pc.close();
      peerConnections.delete(key);
    }
    const remote = remoteSources.get(key);
    if (remote) {
      remote.node.disconnect();
      remote.audioElement.srcObject = null;
      remoteSources.delete(key);
    }
    pendingCandidates.delete(key);
    reportConnectedTo();
  }

  function scheduleRetry() {
    if (retryTimeout !== null) return;
    retryTimeout = setTimeout(() => {
      retryTimeout = null;
      applyRouting(connections);
    }, RETRY_DELAY);
  }

  function createPeerConnection(key, from, to) {
    const remoteIndex = from === index ? to : from;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerConnections.set(key, pc);

    pc.onconnectionstatechange = () => {
      console.log(`[webrtc] ${key}:`, pc.connectionState);
      if (pc.connectionState === 'failed' && peerConnections.get(key) === pc) {
        closePeerConnection(key);
        if (from === index) scheduleRetry(); // the sender opens it again
        return;
      }
      reportConnectedTo();
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        sendSignal(remoteIndex, { type: 'ice-candidate', connectionFrom: from, connectionTo: to, candidate });
      }
    };

    return pc;
  }

  async function addCandidates(key, pc) {
    const candidates = pendingCandidates.get(key) ?? [];
    pendingCandidates.delete(key);
    for (const candidate of candidates) await pc.addIceCandidate(candidate);
  }

  async function initiatePeerConnection(toIndex) {
    const key = pcKey(index, toIndex);
    if (peerConnections.has(key)) return;

    const pc = createPeerConnection(key, index, toIndex);
    mediaStreamDestination.stream.getAudioTracks()
      .forEach((track) => pc.addTrack(track, mediaStreamDestination.stream));

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(toIndex, { type: 'offer', connectionFrom: index, connectionTo: toIndex, sdp: offer });
    } catch (err) {
      console.error(`[webrtc] could not offer ${key}:`, err.message);
    }
  }

  async function handleSignal(payload) {
    const { type, connectionFrom, connectionTo } = payload;
    const key = pcKey(connectionFrom, connectionTo);

    if (type === 'offer') {
      // a new offer for a connection we already have: the sender started again
      if (peerConnections.has(key)) {
        const queued = pendingCandidates.get(key);
        closePeerConnection(key);
        if (queued) pendingCandidates.set(key, queued);
      }

      const pc = createPeerConnection(key, connectionFrom, connectionTo);
      pc.ontrack = ({ streams }) => {
        if (remoteSources.has(key) || !streams[0]) return;
        // Chrome only pulls a remote stream into Web Audio while a media element
        // plays it, and skips decoding when that element is muted: play it at
        // volume 0 instead.
        const audioElement = new Audio();
        audioElement.srcObject = streams[0];
        audioElement.volume = 0;
        audioElement.play().catch((err) => console.warn('[webrtc] audio element:', err.message));

        const node = audioContext.createMediaStreamSource(streams[0]);
        node.connect(destination);
        remoteSources.set(key, { node, audioElement });
        console.log(`[webrtc] receiving from player ${connectionFrom}`);
      };

      await pc.setRemoteDescription(payload.sdp);
      await addCandidates(key, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(connectionFrom, { type: 'answer', connectionFrom, connectionTo, sdp: answer });
    } else if (type === 'answer') {
      const pc = peerConnections.get(key);
      if (!pc || pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(payload.sdp);
      await addCandidates(key, pc);
    } else if (type === 'ice-candidate') {
      const pc = peerConnections.get(key);
      if (pc && pc.remoteDescription) {
        await pc.addIceCandidate(payload.candidate);
      } else {
        if (!pendingCandidates.has(key)) pendingCandidates.set(key, []);
        pendingCandidates.get(key).push(payload.candidate);
      }
    }
  }

  client.socket.addListener('webrtc:signal', (payload) => {
    const key = pcKey(payload.connectionFrom, payload.connectionTo);
    const previous = signalQueues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => handleSignal(payload))
      .catch((err) => console.error(`[webrtc] ${payload.type} ${key}:`, err.message));
    signalQueues.set(key, next);
  });

  // Open the routes from this phone, close the ones removed from the matrix.
  function applyRouting(next) {
    connections = next;
    const outgoing = new Set(connections.filter((c) => c.from === index).map((c) => c.to));
    const incoming = new Set(connections.filter((c) => c.to === index).map((c) => c.from));

    for (const key of [...peerConnections.keys()]) {
      const [from, to] = key.split('-').map(Number);
      if (from === index && !outgoing.has(to)) closePeerConnection(key);
      if (to === index && !incoming.has(from)) closePeerConnection(key);
    }
    for (const toIndex of outgoing) initiatePeerConnection(toIndex);
  }

  // A player's page loaded again: its connections with this phone are gone.
  client.socket.addListener('webrtc:peer-joined', (peerIndex) => {
    for (const key of [...peerConnections.keys()]) {
      const [from, to] = key.split('-').map(Number);
      if (from === peerIndex || to === peerIndex) closePeerConnection(key);
    }
    applyRouting(connections);
  });

  client.socket.send('webrtc:register', index);

  const routing = await client.stateManager.attach('routing');
  applyRouting(routing.get('connections') ?? []);
  routing.onUpdate(() => applyRouting(routing.get('connections') ?? []));

  window.addEventListener('pagehide', () => {
    for (const key of [...peerConnections.keys()]) closePeerConnection(key);
  });
}
