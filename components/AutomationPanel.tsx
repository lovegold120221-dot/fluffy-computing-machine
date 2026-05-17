import React, { useState, useEffect } from 'react';
import * as api from '../lib/api-client';

export default function AutomationPanel() {
  const [automations, setAutomations] = useState<any[]>([]);
  const [runs, setRuns] = useState<Record<string, any[]>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    title: '', description: '', scheduleType: 'daily', time: '08:00', outputFormat: 'summary',
  });

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.fetchAutomations();
      setAutomations(data);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    try {
      await api.createAutomation({
        title: form.title,
        description: form.description,
        schedule: { type: form.scheduleType, time: form.time, timezone: 'Europe/Brussels' },
        output: { format: form.outputFormat },
      });
      setShowCreate(false);
      setForm({ title: '', description: '', scheduleType: 'daily', time: '08:00', outputFormat: 'summary' });
      load();
    } catch (e) { console.error(e); }
  };

  const handleRunNow = async (id: string) => {
    try {
      await api.runAutomationNow(id);
      load();
    } catch (e) { console.error(e); }
  };

  const handleToggle = async (a: any) => {
    try {
      await api.updateAutomation(a.id, { status: a.status === 'active' ? 'paused' : 'active' });
      load();
    } catch (e) { console.error(e); }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteAutomation(id);
      load();
    } catch (e) { console.error(e); }
  };

  const loadRuns = async (id: string) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    try {
      const data = await api.fetchAutomationRuns(id);
      setRuns(prev => ({ ...prev, [id]: data }));
    } catch (e) { console.error(e); }
  };

  return (
    <div style={{ padding: '24px', overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h3 style={{ margin: 0, color: 'var(--accent-active)', fontSize: '18px' }}>Automations</h3>
        <button className="btn" style={{ padding: '8px 16px', borderRadius: '10px', border: 0, background: 'var(--accent-primary)', color: 'var(--accent-primary-text)', fontWeight: 700, cursor: 'pointer' }} onClick={() => setShowCreate(!showCreate)}>
          + New Automation
        </button>
      </div>

      {showCreate && (
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)', borderRadius: '14px', padding: '20px', marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <h4 style={{ margin: 0, color: 'var(--accent-active)' }}>Create Automation</h4>
          <input className="form-input" placeholder="Title" value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} style={{ padding: '10px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: '#fff' }} />
          <textarea className="form-input" placeholder="Description / workflow instruction for Hermes..." value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} style={{ padding: '10px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: '#fff', minHeight: '80px', resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <select className="form-input" value={form.scheduleType} onChange={e => setForm(p => ({ ...p, scheduleType: e.target.value }))} style={{ padding: '10px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: '#fff', flex: 1 }}>
              <option value="once">Once</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
            <input type="time" className="form-input" value={form.time} onChange={e => setForm(p => ({ ...p, time: e.target.value }))} style={{ padding: '10px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: '#fff' }} />
            <select className="form-input" value={form.outputFormat} onChange={e => setForm(p => ({ ...p, outputFormat: e.target.value }))} style={{ padding: '10px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: '#fff', flex: 1 }}>
              <option value="summary">Summary</option>
              <option value="report">Report</option>
              <option value="document">Document</option>
              <option value="dashboard_update">Dashboard Update</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn" style={{ padding: '10px 20px', borderRadius: '10px', border: 0, background: 'var(--accent-primary)', color: 'var(--accent-primary-text)', fontWeight: 700, cursor: 'pointer' }} onClick={handleCreate}>Create</button>
            <button className="btn" style={{ padding: '10px 20px', borderRadius: '10px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }} onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading...</p>
      ) : automations.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '40px' }}>No automations yet. Beatrice can create one for you.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {automations.map(a => (
            <div key={a.id} style={{ background: 'var(--bg-panel)', border: `1px solid ${a.status === 'active' ? 'rgba(203,251,69,0.2)' : 'var(--border-color)'}`, borderRadius: '14px', overflow: 'hidden' }}>
              <div style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span style={{ fontWeight: 600, fontSize: '14px' }}>{a.title}</span>
                    <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '999px', background: a.status === 'active' ? 'rgba(203,251,69,0.15)' : 'rgba(255,255,255,0.05)', color: a.status === 'active' ? 'var(--accent-active)' : 'var(--text-muted)', fontWeight: 700 }}>{a.status}</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    <span>{a.schedule?.type || 'once'} {a.schedule?.time || ''}</span>
                    {a.last_run_at && <span>Last: {new Date(a.last_run_at).toLocaleDateString()} {new Date(a.last_run_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
                    {a.next_run_at && <span>Next: {new Date(a.next_run_at).toLocaleDateString()} {new Date(a.next_run_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                  <button className="pill-btn" style={{ fontSize: '11px', padding: '4px 10px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-main)', cursor: 'pointer' }} onClick={() => handleRunNow(a.id)} title="Run now"><i className="ph-bold ph-play"></i></button>
                  <button className="pill-btn" style={{ fontSize: '11px', padding: '4px 10px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-main)', cursor: 'pointer' }} onClick={() => handleToggle(a)} title={a.status === 'active' ? 'Pause' : 'Resume'}><i className={`ph-bold ph-${a.status === 'active' ? 'pause' : 'play'}`}></i></button>
                  <button className="pill-btn" style={{ fontSize: '11px', padding: '4px 10px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-main)', cursor: 'pointer' }} onClick={() => loadRuns(a.id)} title="History"><i className="ph-bold ph-clock-counter-clockwise"></i></button>
                  <button className="pill-btn" style={{ fontSize: '11px', padding: '4px 10px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--accent-danger)', cursor: 'pointer' }} onClick={() => handleDelete(a.id)} title="Delete"><i className="ph-bold ph-trash"></i></button>
                </div>
              </div>
              {expandedId === a.id && (
                <div style={{ borderTop: '1px solid var(--border-color)', padding: '12px 16px', background: 'rgba(0,0,0,0.15)', maxHeight: '240px', overflowY: 'auto' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>Run History</div>
                  {(runs[a.id] || []).length === 0 ? (
                    <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No runs yet.</p>
                  ) : (
                    (runs[a.id] || []).map((r: any) => (
                      <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: '11px' }}>
                        <span style={{ color: r.status === 'completed' ? 'var(--accent-active)' : r.status === 'failed' ? 'var(--accent-danger)' : 'var(--text-muted)', fontWeight: 600 }}>{r.status}</span>
                        <span style={{ color: 'var(--text-muted)' }}>{r.started_at ? new Date(r.started_at).toLocaleString() : '-'}</span>
                        {r.error && <span style={{ color: 'var(--accent-danger)', marginLeft: '8px' }}>{r.error}</span>}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
