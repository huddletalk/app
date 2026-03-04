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
import { Device } from "mediasoup-client";
import type {
  Consumer,
  DtlsParameters,
  IceCandidate,
  IceParameters,
  MediaKind,
  Producer,
  RtpCapabilities,
  RtpParameters,
  SctpParameters,
  Transport,
} from "mediasoup-client/types";
import {
  MediaStream,
  mediaDevices,
  registerGlobals,
} from "react-native-webrtc";

type Room = {
  room_id: string;
  capacity: number;
};

type TransportDirection = "send" | "recv";

type ClientSignal =
  | { type: "join"; room_id: string }
  | { type: "create_webrtc_transport"; direction: TransportDirection }
  | {
      type: "connect_webrtc_transport";
      transport_id: string;
      dtls_parameters: DtlsParameters;
    }
  | {
      type: "produce";
      transport_id: string;
      kind: MediaKind;
      rtp_parameters: RtpParameters;
    }
  | {
      type: "consume";
      transport_id: string;
      producer_id: string;
      rtp_capabilities: RtpCapabilities;
    }
  | { type: "resume_consumer"; consumer_id: string }
  | { type: "ping" };

type JoinedSignal = {
  type: "joined";
  peer_id: string;
  room_id: string;
  router_rtp_capabilities: RtpCapabilities;
  existing_producer_ids: string[];
};

type WebrtcTransportCreatedSignal = {
  type: "webrtc_transport_created";
  direction: TransportDirection;
  transport_id: string;
  ice_parameters: IceParameters;
  ice_candidates: IceCandidate[];
  dtls_parameters: DtlsParameters;
  sctp_parameters?: SctpParameters;
};

type TransportConnectedSignal = {
  type: "transport_connected";
  transport_id: string;
};

type ProducedSignal = {
  type: "produced";
  producer_id: string;
};

type NewProducerSignal = {
  type: "new_producer";
  peer_id: string;
  producer_id: string;
};

type ConsumedSignal = {
  type: "consumed";
  consumer_id: string;
  producer_id: string;
  kind: MediaKind;
  rtp_parameters: RtpParameters;
};

type ConsumerResumedSignal = {
  type: "consumer_resumed";
  consumer_id: string;
};

type PeerLeftSignal = {
  type: "peer_left";
  peer_id: string;
};

type ErrorSignal = {
  type: "error";
  message: string;
};

type PongSignal = {
  type: "pong";
};

type ServerSignal =
  | JoinedSignal
  | WebrtcTransportCreatedSignal
  | TransportConnectedSignal
  | ProducedSignal
  | NewProducerSignal
  | ConsumedSignal
  | ConsumerResumedSignal
  | PeerLeftSignal
  | ErrorSignal
  | PongSignal;

type ServerEnvelope = ServerSignal & {
  request_id?: number;
};

type PendingRequest = {
  resolve: (signal: ServerSignal) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

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
  const deviceRef = useRef<Device | null>(null);
  const sendTransportRef = useRef<Transport | null>(null);
  const recvTransportRef = useRef<Transport | null>(null);
  const producerRef = useRef<Producer | null>(null);
  const consumersRef = useRef<Map<string, Consumer>>(new Map());
  const localStreamRef = useRef<any | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastAudioBytesRef = useRef<{ bytes: number; timestampMs: number } | null>(
    null,
  );
  const globalsRegisteredRef = useRef(false);
  const nextRequestIdRef = useRef(1);
  const pendingRequestsRef = useRef<Map<number, PendingRequest>>(new Map());
  const consumedProducerIdsRef = useRef<Set<string>>(new Set());
  const queuedProducerIdsRef = useRef<Set<string>>(new Set());

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

  const rejectAllPendingRequests = useCallback((reason: string) => {
    for (const pending of pendingRequestsRef.current.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    pendingRequestsRef.current.clear();
  }, []);

  const disconnect = useCallback(() => {
    rejectAllPendingRequests("signaling disconnected");

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    producerRef.current?.close();
    producerRef.current = null;

    for (const consumer of consumersRef.current.values()) {
      consumer.close();
    }
    consumersRef.current.clear();

    sendTransportRef.current?.close();
    sendTransportRef.current = null;
    recvTransportRef.current?.close();
    recvTransportRef.current = null;

    deviceRef.current = null;
    remoteStreamRef.current = null;
    consumedProducerIdsRef.current.clear();
    queuedProducerIdsRef.current.clear();

    stopAudioStatsLoop();
    stopLocalStream();
    setActiveRoom(null);
    setConnectionState("new");
  }, [rejectAllPendingRequests, stopAudioStatsLoop, stopLocalStream]);

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
    (sendTransport: Transport) => {
      stopAudioStatsLoop();
      setAudioSendStatus("collecting audio stats...");

      statsIntervalRef.current = setInterval(async () => {
        try {
          const rawStats = await sendTransport.getStats();
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

  const sendRequest = useCallback(
    <T extends ServerSignal>(signal: ClientSignal): Promise<T> => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("signaling socket is not open"));
      }

      const requestId = nextRequestIdRef.current++;

      return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingRequestsRef.current.delete(requestId);
          reject(new Error(`request timed out for '${signal.type}'`));
        }, 12_000);

        pendingRequestsRef.current.set(requestId, {
          resolve: resolve as (signal: ServerSignal) => void,
          reject,
          timeout,
        });

        ws.send(
          JSON.stringify({
            request_id: requestId,
            ...signal,
          }),
        );
      });
    },
    [],
  );

  const consumeProducer = useCallback(
    async (producerId: string, roomId: string) => {
      const device = deviceRef.current;
      const recvTransport = recvTransportRef.current;

      if (!device || !recvTransport) {
        queuedProducerIdsRef.current.add(producerId);
        return;
      }

      if (consumedProducerIdsRef.current.has(producerId)) {
        return;
      }
      consumedProducerIdsRef.current.add(producerId);

      try {
        const consumed = await sendRequest<ConsumedSignal>({
          type: "consume",
          transport_id: recvTransport.id,
          producer_id: producerId,
          rtp_capabilities: device.rtpCapabilities,
        });

        const consumer = await recvTransport.consume({
          id: consumed.consumer_id,
          producerId: consumed.producer_id,
          kind: consumed.kind,
          rtpParameters: consumed.rtp_parameters,
        });

        consumersRef.current.set(consumer.id, consumer);

        if (!remoteStreamRef.current) {
          remoteStreamRef.current = new MediaStream();
        }
        remoteStreamRef.current.addTrack(consumer.track as any);

        await sendRequest<ConsumerResumedSignal>({
          type: "resume_consumer",
          consumer_id: consumer.id,
        });

        setStatus(`receiving media in ${roomId}`);
      } catch (error) {
        consumedProducerIdsRef.current.delete(producerId);
        const message = formatError(error, "failed to consume remote audio");
        setErrorMessage(message);
        setStatus("failed consuming remote audio");
      }
    },
    [sendRequest],
  );

  const drainQueuedProducers = useCallback(
    async (roomId: string) => {
      const producerIds = [...queuedProducerIdsRef.current];
      queuedProducerIdsRef.current.clear();

      for (const producerId of producerIds) {
        await consumeProducer(producerId, roomId);
      }
    },
    [consumeProducer],
  );

  const createTransport = useCallback(
    async (
      device: Device,
      direction: TransportDirection,
      roomId: string,
    ): Promise<Transport> => {
      const created = await sendRequest<WebrtcTransportCreatedSignal>({
        type: "create_webrtc_transport",
        direction,
      });

      const transport: Transport =
        direction === "send"
          ? device.createSendTransport({
              id: created.transport_id,
              iceParameters: created.ice_parameters,
              iceCandidates: created.ice_candidates,
              dtlsParameters: created.dtls_parameters,
              sctpParameters: created.sctp_parameters,
            })
          : device.createRecvTransport({
              id: created.transport_id,
              iceParameters: created.ice_parameters,
              iceCandidates: created.ice_candidates,
              dtlsParameters: created.dtls_parameters,
              sctpParameters: created.sctp_parameters,
            });

      transport.on("connect", ({ dtlsParameters }, callback, errback) => {
        void (async () => {
          try {
            await sendRequest<TransportConnectedSignal>({
              type: "connect_webrtc_transport",
              transport_id: created.transport_id,
              dtls_parameters: dtlsParameters as DtlsParameters,
            });
            callback();
          } catch (error) {
            errback(error as Error);
          }
        })();
      });

      if (direction === "send") {
        transport.on("produce", ({ kind, rtpParameters }, callback, errback) => {
          void (async () => {
            try {
              const produced = await sendRequest<ProducedSignal>({
                type: "produce",
                transport_id: created.transport_id,
                kind: kind as MediaKind,
                rtp_parameters: rtpParameters as RtpParameters,
              });
              callback({ id: produced.producer_id });
            } catch (error) {
              errback(error as Error);
            }
          })();
        });
      }

      transport.on("connectionstatechange", (state) => {
        setConnectionState(state);
        setStatus(`webrtc ${state} (${roomId}, ${direction})`);
      });

      return transport;
    },
    [sendRequest],
  );

  const handleServerEvent = useCallback(
    (signal: ServerSignal, roomId: string) => {
      if (signal.type === "new_producer") {
        void consumeProducer(signal.producer_id, roomId);
        return;
      }
      if (signal.type === "peer_left") {
        setStatus(`peer ${signal.peer_id} left ${roomId}`);
        return;
      }
      if (signal.type === "error") {
        setErrorMessage(signal.message);
        setStatus("server rejected signaling message");
      }
    },
    [consumeProducer],
  );

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

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") {
          return;
        }

        let envelope: ServerEnvelope;
        try {
          envelope = JSON.parse(event.data) as ServerEnvelope;
        } catch (error) {
          const message = formatError(error, "failed to parse signal payload");
          setErrorMessage(message);
          return;
        }

        const requestId = envelope.request_id;
        if (typeof requestId === "number") {
          const pending = pendingRequestsRef.current.get(requestId);
          if (!pending) {
            return;
          }

          pendingRequestsRef.current.delete(requestId);
          clearTimeout(pending.timeout);

          if (envelope.type === "error") {
            pending.reject(new Error(envelope.message));
          } else {
            pending.resolve(envelope);
          }
          return;
        }

        handleServerEvent(envelope, roomId);
      };

      ws.onerror = () => {
        setStatus("websocket error");
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          disconnect();
          setStatus("disconnected");
        }
      };

      ws.onopen = async () => {
        try {
          const micAllowed = await requestMicrophonePermission();
          if (!micAllowed) {
            throw new Error("microphone permission denied");
          }

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

          if (!globalsRegisteredRef.current) {
            registerGlobals();
            globalsRegisteredRef.current = true;
          }

          const device = new Device({ handlerName: "ReactNative106" });
          deviceRef.current = device;

          const joined = await sendRequest<JoinedSignal>({
            type: "join",
            room_id: roomId,
          });

          await device.load({
            routerRtpCapabilities: joined.router_rtp_capabilities,
          });

          const sendTransport = await createTransport(device, "send", roomId);
          const recvTransport = await createTransport(device, "recv", roomId);

          sendTransportRef.current = sendTransport;
          recvTransportRef.current = recvTransport;

          setActiveRoom(joined.room_id);
          setStatus(`joined ${joined.room_id}`);

          startAudioStatsLoop(sendTransport);

          if (!device.canProduce("audio")) {
            throw new Error("this device cannot produce audio");
          }

          const producer = await sendTransport.produce({
            track: audioTracks[0],
          });
          producerRef.current = producer as Producer;

          setStatus(`sending audio in ${joined.room_id}`);

          for (const producerId of joined.existing_producer_ids) {
            await consumeProducer(producerId, joined.room_id);
          }

          await drainQueuedProducers(joined.room_id);
        } catch (error) {
          const message = formatError(error, "unknown connect error");
          setErrorMessage(message);
          setStatus("connection failed");
          disconnect();
        }
      };
    },
    [
      consumeProducer,
      createTransport,
      disconnect,
      drainQueuedProducers,
      handleServerEvent,
      requestMicrophonePermission,
      sendRequest,
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
