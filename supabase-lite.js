/* Meu Financeiro — cliente Supabase mínimo, local e sem CDN.
 * Implementa somente Auth + PostgREST/RPC usados pelo aplicativo.
 * Mantém a Publishable Key no frontend, protegida por RLS no banco.
 */
(function (global) {
  'use strict';

  var SESSION_KEY = 'mfSupabaseLiteSessionV1';

  function makeError(payload, status, fallback) {
    var err = new Error((payload && (payload.message || payload.msg || payload.error_description || payload.error)) || fallback || ('HTTP ' + status));
    if (payload && payload.code) err.code = payload.code;
    err.status = status;
    err.details = payload && payload.details;
    err.hint = payload && payload.hint;
    return err;
  }

  async function parseResponse(response) {
    var text = await response.text();
    var payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch (_) { payload = text; }
    }
    if (!response.ok) throw makeError(typeof payload === 'object' ? payload : null, response.status, typeof payload === 'string' ? payload : null);
    return payload;
  }

  function createClient(baseUrl, apiKey) {
    baseUrl = String(baseUrl || '').replace(/\/$/, '');
    apiKey = String(apiKey || '');
    var listeners = [];
    var refreshPromise = null;

    function readStoredSession() {
      try {
        var raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        var session = JSON.parse(raw);
        return session && session.access_token ? session : null;
      } catch (_) { return null; }
    }

    function storeSession(session) {
      try {
        if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        else localStorage.removeItem(SESSION_KEY);
      } catch (_) {}
    }

    function emit(event, session) {
      listeners.slice().forEach(function (cb) {
        try { cb(event, session); } catch (_) {}
      });
    }

    function sessionFromTokenResponse(data, previous) {
      if (!data || !data.access_token) return null;
      var expiresIn = Number(data.expires_in || (previous && previous.expires_in) || 3600);
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token || (previous && previous.refresh_token) || '',
        token_type: data.token_type || 'bearer',
        expires_in: expiresIn,
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
        user: data.user || (previous && previous.user) || null
      };
    }

    async function authFetch(path, options) {
      options = options || {};
      var headers = Object.assign({
        'apikey': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }, options.headers || {});
      var response = await fetch(baseUrl + '/auth/v1' + path, Object.assign({}, options, { headers: headers, cache: 'no-store' }));
      return parseResponse(response);
    }

    async function refreshSession(session) {
      if (!session || !session.refresh_token) return null;
      if (refreshPromise) return refreshPromise;
      refreshPromise = (async function () {
        try {
          var data = await authFetch('/token?grant_type=refresh_token', {
            method: 'POST',
            body: JSON.stringify({ refresh_token: session.refresh_token })
          });
          var next = sessionFromTokenResponse(data, session);
          if (!next) throw new Error('O Supabase não retornou uma sessão válida.');
          storeSession(next);
          emit('TOKEN_REFRESHED', next);
          return next;
        } catch (err) {
          storeSession(null);
          emit('SIGNED_OUT', null);
          throw err;
        } finally {
          refreshPromise = null;
        }
      })();
      return refreshPromise;
    }

    async function validSession() {
      var session = readStoredSession();
      if (!session) return null;
      var expiresAt = Number(session.expires_at || 0);
      if (!expiresAt || expiresAt - Math.floor(Date.now() / 1000) > 90) return session;
      try { return await refreshSession(session); }
      catch (_) { return null; }
    }

    async function dataHeaders(extra) {
      var session = await validSession();
      if (!session || !session.access_token) throw new Error('Sessão expirada. Entre novamente.');
      return Object.assign({
        'apikey': apiKey,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }, extra || {});
    }

    async function postgrestRequest(table, spec, mode) {
      var path = baseUrl + '/rest/v1/' + encodeURIComponent(table);
      var method = spec.operation === 'insert' ? 'POST' : 'GET';
      var params = new URLSearchParams();
      if (spec.select) params.set('select', spec.select);
      Object.keys(spec.filters || {}).forEach(function (key) {
        params.set(key, 'eq.' + String(spec.filters[key]));
      });
      var qs = params.toString();
      if (qs) path += '?' + qs;
      var extra = {};
      if (method === 'POST') extra.Prefer = 'return=representation';
      var headers = await dataHeaders(extra);
      var options = { method: method, headers: headers, cache: 'no-store' };
      if (method === 'POST') options.body = JSON.stringify(spec.payload);
      try {
        var response = await fetch(path, options);
        var data = await parseResponse(response);
        if (mode === 'maybeSingle') return { data: Array.isArray(data) ? (data[0] || null) : (data || null), error: null };
        if (mode === 'single') return { data: Array.isArray(data) ? (data[0] || null) : data, error: null };
        return { data: data, error: null };
      } catch (err) {
        return { data: null, error: err };
      }
    }

    function tableBuilder(table) {
      var spec = { operation: 'select', select: '*', filters: {}, payload: null };
      var builder = {
        select: function (columns) { spec.select = columns || '*'; return builder; },
        eq: function (field, value) { spec.filters[field] = value; return builder; },
        insert: function (payload) { spec.operation = 'insert'; spec.payload = payload; return builder; },
        maybeSingle: function () { return postgrestRequest(table, spec, 'maybeSingle'); },
        single: function () { return postgrestRequest(table, spec, 'single'); }
      };
      return builder;
    }

    function rpcBuilder(name, args) {
      return {
        single: async function () {
          try {
            var headers = await dataHeaders({ Prefer: 'return=representation' });
            var response = await fetch(baseUrl + '/rest/v1/rpc/' + encodeURIComponent(name), {
              method: 'POST',
              headers: headers,
              body: JSON.stringify(args || {}),
              cache: 'no-store'
            });
            var data = await parseResponse(response);
            return { data: Array.isArray(data) ? (data[0] || null) : data, error: null };
          } catch (err) {
            return { data: null, error: err };
          }
        }
      };
    }

    var auth = {
      getSession: async function () {
        try {
          var session = await validSession();
          return { data: { session: session }, error: null };
        } catch (err) {
          return { data: { session: null }, error: err };
        }
      },
      onAuthStateChange: function (callback) {
        listeners.push(callback);
        return { data: { subscription: { unsubscribe: function () {
          listeners = listeners.filter(function (x) { return x !== callback; });
        } } } };
      },
      signInWithPassword: async function (credentials) {
        try {
          var data = await authFetch('/token?grant_type=password', {
            method: 'POST',
            body: JSON.stringify({ email: credentials.email, password: credentials.password })
          });
          var session = sessionFromTokenResponse(data, null);
          if (!session) throw new Error('Login realizado sem uma sessão válida.');
          storeSession(session);
          emit('SIGNED_IN', session);
          return { data: { user: session.user, session: session }, error: null };
        } catch (err) {
          return { data: { user: null, session: null }, error: err };
        }
      },
      signUp: async function (credentials) {
        try {
          var data = await authFetch('/signup', {
            method: 'POST',
            body: JSON.stringify({ email: credentials.email, password: credentials.password })
          });
          var session = sessionFromTokenResponse(data, null);
          var user = data && (data.user || (session && session.user)) || null;
          if (session) {
            storeSession(session);
            emit('SIGNED_IN', session);
          }
          return { data: { user: user, session: session }, error: null };
        } catch (err) {
          return { data: { user: null, session: null }, error: err };
        }
      },
      signOut: async function () {
        var session = readStoredSession();
        try {
          if (session && session.access_token) {
            await authFetch('/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + session.access_token }, body: '{}' });
          }
        } catch (_) {}
        storeSession(null);
        emit('SIGNED_OUT', null);
        return { error: null };
      }
    };

    return {
      auth: auth,
      from: tableBuilder,
      rpc: rpcBuilder
    };
  }

  global.supabase = { createClient: createClient };
})(window);
