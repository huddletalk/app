import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
} from "react-native-webrtc";

type Room = {
  room_id: string;
  capacity: number;
};

type ServerSignal =
  | { type: "joined"; peer_id: string; room_id: string }
  | { type: "answer"; sdp: string }
  | { type: "offer"; sdp: string }
  | {
      type: "ice_candidate";
      candidate: string;
      sdp_mid?: string;
      sdp_mline_index?: number;
    }
  | { type: "peer_joined"; peer_id: string }
  | { type: "peer_left"; peer_id: string }
  | { type: "error"; message: string }
  | { type: "pong" };

type IceCandidateSignal = Extract<ServerSignal, { type: "ice_candidate" }>;

// Set this to your Mac's LAN IP for real phones on the same Wi-Fi.
// Empty string = use local emulator/simulator defaults.
const LAN_BACKEND_HOST = "";

const DEFAULT_HTTP_BASE_URL = LAN_BACKEND_HOST
  ? `http://${LAN_BACKEND_HOST}:8080`
  : Platform.OS === "android"
    ? "http://10.0.2.2:8080"
    : "http://127.0.0.1:8080";
const HTTP_BASE_URL = DEFAULT_HTTP_BASE_URL;
const SIGNAL_URL = `${HTTP_BASE_URL.replace(/^http/, "ws")}/signal`;

function formatError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") {
      return serialized;
    }
  } catch {}
  return fallback;
}

export default function App() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeRoom, setActiveRoom] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [connectionState, setConnectionState] = useState("new");
  const [micStatus, setMicStatus] = useState("idle");
  const [audioSendStatus, setAudioSendStatus] = useState("not sending");
  const [micEnabled, setMicEnabled] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<any | null>(null);
  const pendingIceCandidatesRef = useRef<IceCandidateSignal[]>([]);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastAudioBytesRef = useRef<{ bytes: number; timestampMs: number } | null>(
    null,
  );
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const isSettingRemoteAnswerRef = useRef(false);

  const stopAudioStatsLoop = useCallback(() => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
    lastAudioBytesRef.current = null;
    setAudioSendStatus("not sending");
  }, []);

  const stopLocalStream = useCallback(() => {
    if (localStreamRef.current) {
      const tracks = localStreamRef.current.getTracks?.() ?? [];
      for (const track of tracks) {
        track.stop();
      }
      localStreamRef.current = null;
    }
    setMicStatus("idle");
    setMicEnabled(true);
  }, []);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    stopAudioStatsLoop();
    stopLocalStream();
    pendingIceCandidatesRef.current = [];
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;
    isSettingRemoteAnswerRef.current = false;
    setActiveRoom(null);
    setConnectionState("new");
  }, [stopAudioStatsLoop, stopLocalStream]);

  const requestMicrophonePermission = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== "android") {
      return true;
    }

    const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
    const alreadyGranted = await PermissionsAndroid.check(permission);
    if (alreadyGranted) {
      return true;
    }

    const result = await PermissionsAndroid.request(permission);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  }, []);

  const startAudioStatsLoop = useCallback(
    (peer: any) => {
      stopAudioStatsLoop();
      setAudioSendStatus("collecting audio stats...");

      statsIntervalRef.current = setInterval(async () => {
        try {
          const rawStats = await peer.getStats();
          let reports: any[] = [];

          if (rawStats instanceof Map) {
            reports = Array.from(rawStats.values());
          } else if (Array.isArray(rawStats)) {
            reports = rawStats;
          } else if (rawStats && typeof rawStats === "object") {
            reports = Object.values(rawStats as Record<string, unknown>);
          }

          let bytesSent = 0;
          let packetsSent = 0;
          for (const report of reports) {
            if (
              report?.type === "outbound-rtp" &&
              report?.kind === "audio" &&
              report?.isRemote !== true
            ) {
              bytesSent += Number(report.bytesSent ?? 0);
              packetsSent += Number(report.packetsSent ?? 0);
            }
          }

          if (bytesSent <= 0) {
            setAudioSendStatus("connected, waiting for outbound audio packets...");
            return;
          }

          const now = Date.now();
          const previous = lastAudioBytesRef.current;
          if (!previous || now <= previous.timestampMs || bytesSent < previous.bytes) {
            lastAudioBytesRef.current = { bytes: bytesSent, timestampMs: now };
            setAudioSendStatus(`audio sent ${packetsSent} packets`);
            return;
          }

          const deltaBytes = bytesSent - previous.bytes;
          const deltaSeconds = (now - previous.timestampMs) / 1000;
          const kbps = deltaSeconds > 0 ? (deltaBytes * 8) / (deltaSeconds * 1000) : 0;
          lastAudioBytesRef.current = { bytes: bytesSent, timestampMs: now };
          setAudioSendStatus(
            `sending ${kbps.toFixed(1)} kbps (${packetsSent} packets total)`,
          );
        } catch (error) {
          const message = formatError(error, "unknown stats error");
          setAudioSendStatus(`audio stats unavailable (${message})`);
        }
      }, 1500);
    },
    [stopAudioStatsLoop],
  );

  const toggleMicrophone = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) {
      return;
    }

    const tracks = stream.getAudioTracks?.() ?? [];
    if (tracks.length === 0) {
      setMicStatus("no local audio track");
      return;
    }

    const nextEnabled = !tracks[0].enabled;
    for (const track of tracks) {
      track.enabled = nextEnabled;
    }
    setMicEnabled(nextEnabled);
    setMicStatus(nextEnabled ? "capturing" : "muted");
  }, []);

  const flushPendingIceCandidates = useCallback(async (peer: any) => {
    if (!peer?.remoteDescription) {
      return;
    }

    const queued = [...pendingIceCandidatesRef.current];
    pendingIceCandidatesRef.current = [];

    for (const signal of queued) {
      const candidateInit: {
        candidate: string;
        sdpMid?: string | null;
        sdpMLineIndex?: number | null;
      } = {
        candidate: signal.candidate,
      };
      if (signal.sdp_mid !== undefined) {
        candidateInit.sdpMid = signal.sdp_mid;
      }
      if (signal.sdp_mline_index !== undefined) {
        candidateInit.sdpMLineIndex = signal.sdp_mline_index;
      }

      await peer.addIceCandidate(new RTCIceCandidate(candidateInit));
    }
  }, []);

  const fetchRooms = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await fetch(`${HTTP_BASE_URL}/rooms`);
      if (!response.ok) {
        throw new Error(`rooms request failed: ${response.status}`);
      }
      const payload = (await response.json()) as Room[];
      setRooms(payload);
      setStatus(`loaded ${payload.length} room(s)`);
    } catch (error) {
      const message = formatError(error, "unknown error");
      setErrorMessage(message);
      setStatus("failed to load rooms");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRooms();
    return disconnect;
  }, [disconnect, fetchRooms]);

  const sendClientSignal = (payload: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  };

  const joinRoom = useCallback(
    async (roomId: string) => {
      disconnect();
      setErrorMessage(null);
      setStatus(`connecting to ${roomId}...`);
      setConnectionState("connecting");
      setMicStatus("requesting microphone...");
      setAudioSendStatus("not sending");

      const ws = new WebSocket(SIGNAL_URL);
      wsRef.current = ws;

      ws.onopen = async () => {
        try {
          const micAllowed = await requestMicrophonePermission();
          if (!micAllowed) {
            throw new Error("microphone permission denied");
          }

          const peer: any = new RTCPeerConnection({
            iceServers: [],
          });
          peerConnectionRef.current = peer;

          peer.onicecandidate = (event: any) => {
            if (!event.candidate) {
              return;
            }
            sendClientSignal({
              type: "ice_candidate",
              candidate: event.candidate.candidate,
              sdp_mid: event.candidate.sdpMid ?? undefined,
              sdp_mline_index: event.candidate.sdpMLineIndex ?? undefined,
            });
          };

          peer.ontrack = () => {
            setStatus(`receiving media in ${roomId}`);
          };

          peer.onconnectionstatechange = () => {
            const state = peer.connectionState;
            setConnectionState(state);
            setStatus(`webrtc ${state}`);
          };

          const stream = await mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });
          const audioTracks = stream.getAudioTracks?.() ?? [];
          if (audioTracks.length === 0) {
            throw new Error("microphone stream has no audio tracks");
          }

          localStreamRef.current = stream;
          setMicEnabled(audioTracks.every((track: any) => track.enabled !== false));
          setMicStatus("capturing");

          for (const track of audioTracks) {
            peer.addTrack(track, stream);
          }

          startAudioStatsLoop(peer);

          sendClientSignal({ type: "join", room_id: roomId });
        } catch (error) {
          const message = formatError(error, "unknown connect error");
          setErrorMessage(message);
          setStatus("connection failed");
          disconnect();
        }
      };

      ws.onmessage = async (event) => {
        const peer = peerConnectionRef.current;
        if (!peer || typeof event.data !== "string") {
          return;
        }

        let signal: ServerSignal;
        try {
          signal = JSON.parse(event.data) as ServerSignal;
        } catch (error) {
          const message = formatError(error, "failed to parse signal");
          setErrorMessage(message);
          return;
        }

        try {
          if (signal.type === "joined") {
            setActiveRoom(signal.room_id);
            setStatus(`joined ${signal.room_id}`);

            makingOfferRef.current = true;
            try {
              const offer = await peer.createOffer();
              await peer.setLocalDescription(offer);
              sendClientSignal({
                type: "offer",
                sdp: offer.sdp ?? "",
              });
            } finally {
              makingOfferRef.current = false;
            }
            return;
          }
          if (signal.type === "answer") {
            isSettingRemoteAnswerRef.current = true;
            try {
              await peer.setRemoteDescription(
                new RTCSessionDescription({ type: "answer", sdp: signal.sdp }),
              );
              await flushPendingIceCandidates(peer);
            } finally {
              isSettingRemoteAnswerRef.current = false;
            }
            return;
          }
          if (signal.type === "offer") {
            const offerCollision =
              makingOfferRef.current ||
              (peer.signalingState && peer.signalingState !== "stable");
            ignoreOfferRef.current = offerCollision;
            if (ignoreOfferRef.current) {
              return;
            }

            await peer.setRemoteDescription(
              new RTCSessionDescription({ type: "offer", sdp: signal.sdp }),
            );
            await flushPendingIceCandidates(peer);
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            sendClientSignal({ type: "answer", sdp: answer.sdp ?? "" });
            return;
          }
          if (signal.type === "ice_candidate") {
            if (!signal.candidate || ignoreOfferRef.current) {
              return;
            }

            const hasRemoteDescription = Boolean(peer.remoteDescription);
            if (!hasRemoteDescription) {
              pendingIceCandidatesRef.current.push(signal);
              return;
            }

            const candidateInit: {
              candidate: string;
              sdpMid?: string | null;
              sdpMLineIndex?: number | null;
            } = {
              candidate: signal.candidate,
            };
            if (signal.sdp_mid !== undefined) {
              candidateInit.sdpMid = signal.sdp_mid;
            }
            if (signal.sdp_mline_index !== undefined) {
              candidateInit.sdpMLineIndex = signal.sdp_mline_index;
            }

            await peer.addIceCandidate(new RTCIceCandidate(candidateInit));
            return;
          }
          if (signal.type === "peer_joined") {
            setStatus(`peer ${signal.peer_id} joined ${roomId}`);
            return;
          }
          if (signal.type === "peer_left") {
            setStatus(`peer ${signal.peer_id} left ${roomId}`);
            return;
          }
          if (signal.type === "error") {
            setErrorMessage(signal.message);
            setStatus("server rejected signaling message");
            return;
          }
          if (signal.type === "pong") {
            return;
          }
        } catch (error) {
          const message = formatError(error, "webrtc update failed");
          setErrorMessage(message);
          setStatus("webrtc signaling failed");
        }
      };

      ws.onerror = () => {
        setStatus("websocket error");
      };

      ws.onclose = () => {
        setStatus("disconnected");
      };
    },
    [
      disconnect,
      flushPendingIceCandidates,
      requestMicrophonePermission,
      startAudioStatsLoop,
    ],
  );

  const leaveRoom = useCallback(() => {
    setStatus("left room");
    disconnect();
  }, [disconnect]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>HuddleTalk</Text>
          <Text style={styles.subtitle}>Backend: {HTTP_BASE_URL}</Text>
          <Text style={styles.status}>Status: {status}</Text>
          {errorMessage ? <Text style={styles.error}>Error: {errorMessage}</Text> : null}
        </View>

        {activeRoom ? (
          <View style={styles.roomScreen}>
            <Text style={styles.roomScreenTitle}>Room: {activeRoom}</Text>
            <Text style={styles.status}>Connection: {connectionState}</Text>
            <Text style={styles.status}>Mic: {micStatus}</Text>
            <Text style={styles.status}>Outbound audio: {audioSendStatus}</Text>
            <View style={styles.actions}>
              <Pressable style={styles.button} onPress={toggleMicrophone}>
                <Text style={styles.buttonText}>{micEnabled ? "Mute Mic" : "Unmute Mic"}</Text>
              </Pressable>
              <Pressable style={styles.dangerButton} onPress={leaveRoom}>
                <Text style={styles.buttonText}>Leave Room</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <>
            <View style={styles.actions}>
              <Pressable style={styles.button} onPress={() => void fetchRooms()}>
                <Text style={styles.buttonText}>Refresh Rooms</Text>
              </Pressable>
            </View>

            {loading ? (
              <ActivityIndicator size="large" />
            ) : (
              <FlatList
                data={rooms}
                keyExtractor={(room) => room.room_id}
                contentContainerStyle={styles.roomList}
                renderItem={({ item }) => (
                  <Pressable
                    style={styles.roomCard}
                    onPress={() => {
                      void joinRoom(item.room_id);
                    }}
                  >
                    <Text style={styles.roomName}>{item.room_id}</Text>
                    <Text style={styles.roomMeta}>capacity: {item.capacity}</Text>
                    <Text style={styles.roomAction}>Tap to join</Text>
                  </Pressable>
                )}
                ListEmptyComponent={<Text style={styles.empty}>No rooms found.</Text>}
              />
            )}
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f4f6f8",
  },
  container: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 24,
  },
  header: {
    marginBottom: 16,
    gap: 4,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    color: "#1b1f24",
  },
  subtitle: {
    fontSize: 12,
    color: "#59636e",
  },
  status: {
    fontSize: 14,
    color: "#2f3b4a",
  },
  error: {
    marginTop: 4,
    color: "#9f1a1a",
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 16,
  },
  button: {
    backgroundColor: "#1f6feb",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  dangerButton: {
    backgroundColor: "#cf222e",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  buttonText: {
    color: "#ffffff",
    fontWeight: "600",
  },
  roomScreen: {
    backgroundColor: "#ffffff",
    borderColor: "#d0d7de",
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  roomScreenTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#1f2328",
    marginBottom: 4,
  },
  roomList: {
    gap: 10,
    paddingBottom: 24,
  },
  roomCard: {
    backgroundColor: "#ffffff",
    padding: 14,
    borderRadius: 12,
    borderColor: "#d0d7de",
    borderWidth: 1,
    gap: 3,
  },
  roomName: {
    fontSize: 18,
    fontWeight: "600",
    color: "#1f2328",
  },
  roomMeta: {
    fontSize: 13,
    color: "#59636e",
  },
  roomAction: {
    marginTop: 6,
    fontSize: 12,
    color: "#1f6feb",
  },
  empty: {
    color: "#59636e",
    fontSize: 14,
  },
});
