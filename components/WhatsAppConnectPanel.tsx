import React, { useEffect, useState, useCallback } from "react";
import * as api from "../lib/api-client";

type WaStatus = "not_connected" | "connecting" | "connected" | "disconnected" | "error";

export default function WhatsAppConnectPanel() {
  const [status, setStatus] = useState<WaStatus>("not_connected");
  const [qrBase64, setQrBase64] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await api.fetchWhatsAppStatus();
      setStatus(data.status as WaStatus);
      setPhoneNumber(data.phoneNumber || null);
      if (data.status === "connected") {
        setQrBase64(null);
        setPairingCode(null);
      }
      if (data.qrBase64 && !qrBase64) {
        setQrBase64(data.qrBase64);
      }
    } catch {
      // ignore
    }
  }, [qrBase64]);

  // Poll status while connecting
  useEffect(() => {
    fetchStatus();
    if (status === "connecting") {
      const interval = setInterval(fetchStatus, 3000);
      return () => clearInterval(interval);
    }
  }, [status, fetchStatus]);

  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.connectWhatsApp();
      setStatus(data.status as WaStatus);
      if (data.qrBase64) {
        setQrBase64(data.qrBase64);
      }
      if (data.pairingCode) setPairingCode(data.pairingCode);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.disconnectWhatsApp();
      setStatus(data.status as WaStatus);
      setQrBase64(null);
      setPairingCode(null);
      setPhoneNumber(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="whatsapp-panel" style={{ padding: "20px" }}>
      <h3 style={{ color: "var(--text-main)", fontSize: "16px", marginBottom: "16px" }}>
        <i className="ph ph-whatsapp-logo" style={{ marginRight: "8px", color: "#25D366" }} />
        WhatsApp Connection
      </h3>

      {error && (
        <div style={{
          background: "rgba(239,68,68,0.1)",
          border: "1px solid rgba(239,68,68,0.2)",
          borderRadius: "8px",
          padding: "10px 14px",
          color: "#ef4444",
          fontSize: "13px",
          marginBottom: "12px",
        }}>
          {error}
        </div>
      )}

      {/* Connected state */}
      {status === "connected" && (
        <div style={{
          background: "rgba(37,211,102,0.08)",
          border: "1px solid rgba(37,211,102,0.2)",
          borderRadius: "12px",
          padding: "20px",
          textAlign: "center",
        }}>
          <div style={{
            width: "48px",
            height: "48px",
            borderRadius: "50%",
            background: "#25D366",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 12px",
          }}>
            <i className="ph-bold ph-check" style={{ color: "#fff", fontSize: "24px" }} />
          </div>
          <p style={{ color: "var(--text-main)", fontWeight: 600, marginBottom: "4px" }}>
            Connected
          </p>
          {phoneNumber && (
            <p style={{ color: "var(--text-muted)", fontSize: "13px", marginBottom: "12px" }}>
              {phoneNumber}
            </p>
          )}
          <button
            onClick={handleDisconnect}
            disabled={loading}
            style={{
              background: "rgba(239,68,68,0.1)",
              color: "#ef4444",
              border: "none",
              borderRadius: "8px",
              padding: "8px 20px",
              cursor: "pointer",
              fontSize: "13px",
              fontWeight: 600,
            }}
          >
            Disconnect WhatsApp
          </button>
        </div>
      )}

      {/* Connecting / QR display */}
      {status === "connecting" && (
        <div style={{ textAlign: "center" }}>
          {qrBase64 ? (
            <>
              <p style={{ color: "var(--text-muted)", fontSize: "13px", marginBottom: "12px" }}>
                Open WhatsApp → <strong>Settings</strong> → <strong>Linked Devices</strong> → <strong>Link a Device</strong> → scan this QR code
              </p>
              <img
                src={qrBase64}
                alt="WhatsApp QR Code"
                style={{
                  width: "240px",
                  height: "240px",
                  borderRadius: "12px",
                  border: "2px solid rgba(37,211,102,0.2)",
                  margin: "0 auto",
                  display: "block",
                }}
              />
              {pairingCode && (
                <p style={{ color: "var(--text-muted)", fontSize: "12px", marginTop: "12px" }}>
                  Pairing code: <strong>{pairingCode}</strong>
                </p>
              )}
              <p style={{ color: "var(--text-muted)", fontSize: "12px", marginTop: "8px" }}>
                Waiting for scan...
              </p>
            </>
          ) : (
            <p style={{ color: "var(--text-muted)", fontSize: "13px" }}>
              Generating QR code...
            </p>
          )}
        </div>
      )}

      {/* Not connected */}
      {(status === "not_connected" || status === "disconnected") && (
        <div style={{ textAlign: "center" }}>
          <p style={{ color: "var(--text-muted)", fontSize: "13px", marginBottom: "16px" }}>
            Connect your WhatsApp account to send and receive messages through Beatrice.
          </p>
          <button
            onClick={handleConnect}
            disabled={loading}
            style={{
              background: "#25D366",
              color: "#fff",
              border: "none",
              borderRadius: "10px",
              padding: "12px 28px",
              cursor: "pointer",
              fontSize: "14px",
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <i className="ph ph-whatsapp-logo" style={{ fontSize: "18px" }} />
            {loading ? "Connecting..." : "Connect WhatsApp"}
          </button>
        </div>
      )}

      {status === "error" && (
        <div style={{ textAlign: "center" }}>
          <p style={{ color: "#ef4444", fontSize: "13px", marginBottom: "12px" }}>
            Connection failed. Please try again.
          </p>
          <button
            onClick={handleConnect}
            disabled={loading}
            style={{
              background: "var(--accent-primary)",
              color: "#fff",
              border: "none",
              borderRadius: "10px",
              padding: "10px 24px",
              cursor: "pointer",
              fontSize: "13px",
              fontWeight: 600,
            }}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
