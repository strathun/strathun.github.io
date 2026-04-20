// assets/auth.js — shared Supabase auth helper
// Included on every page. Exposes: window.sb, window.getUser(), window.signOut()

const SUPABASE_URL = 'https://gfiigncjwtuslwqlyasr.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdmaWlnbmNqd3R1c2x3cWx5YXNyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3MDIxMjcsImV4cCI6MjA5MjI3ODEyN30.skircARSZLElxN1w0aoxRP9sbIRDEPmSC4hbtHQSqyw';

// Load Supabase from CDN then init
(function () {
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
  script.onload = () => {
    window.sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    document.dispatchEvent(new Event('sb-ready'));
  };
  document.head.appendChild(script);
})();

window.getUser = async function () {
  const { data: { session } } = await window.sb.auth.getSession();
  return session?.user ?? null;
};

window.signOut = async function () {
  await window.sb.auth.signOut();
  window.location.href = '/';
};

// Renders a standard email/password auth box into #auth-gate,
// then calls onSuccess(user) when signed in.
window.renderAuthGate = function (onSuccess) {
  document.dispatchEvent(new Event('sb-ready')); // no-op if already fired
  const run = async () => {
    const user = await window.getUser();
    if (user) { onSuccess(user); return; }

    const gate = document.getElementById('auth-gate');
    if (!gate) return;
    gate.classList.remove('hidden');

    let mode = 'signin';
    gate.innerHTML = authHTML(mode);
    bindAuth(gate, onSuccess, () => {
      mode = mode === 'signin' ? 'signup' : 'signin';
      gate.innerHTML = authHTML(mode);
      bindAuth(gate, onSuccess, arguments.callee);
    });
  };

  if (window.sb) { run(); }
  else { document.addEventListener('sb-ready', run, { once: true }); }
};

function authHTML(mode) {
  const label = mode === 'signin' ? 'sign in' : 'create account';
  const toggle = mode === 'signin'
    ? `no account? <a id="auth-toggle-btn">sign up</a>`
    : `have an account? <a id="auth-toggle-btn">sign in</a>`;
  return `
    <div class="auth-box">
      <h2>${label}</h2>
      <p>strathun.github.io — personal hub</p>
      <div class="auth-field"><label>email</label><input id="auth-email" type="email" placeholder="you@example.com" autocomplete="email"></div>
      <div class="auth-field"><label>password</label><input id="auth-password" type="password" placeholder="••••••••" autocomplete="${mode === 'signin' ? 'current-password' : 'new-password'}"></div>
      <button class="auth-btn" id="auth-submit">${label}</button>
      <div class="auth-error" id="auth-error"></div>
      <div class="auth-toggle">${toggle}</div>
    </div>`;
}

function bindAuth(gate, onSuccess, onToggle) {
  const emailEl = gate.querySelector('#auth-email');
  const passEl  = gate.querySelector('#auth-password');
  const btn     = gate.querySelector('#auth-submit');
  const errEl   = gate.querySelector('#auth-error');
  const toggle  = gate.querySelector('#auth-toggle-btn');
  const isSignup = btn.textContent.trim() === 'create account';

  if (toggle) toggle.addEventListener('click', onToggle);

  const submit = async () => {
    const email = emailEl.value.trim();
    const password = passEl.value;
    if (!email || !password) { errEl.textContent = 'please fill in all fields'; return; }
    btn.disabled = true;
    btn.textContent = '...';
    errEl.textContent = '';

    let error;
    if (isSignup) {
      ({ error } = await window.sb.auth.signUp({ email, password }));
      if (!error) { errEl.style.color = 'var(--accent2)'; errEl.textContent = 'check your email to confirm, then sign in.'; btn.disabled = false; btn.textContent = 'create account'; return; }
    } else {
      let data;
      ({ data, error } = await window.sb.auth.signInWithPassword({ email, password }));
      if (!error && data.user) { gate.classList.add('hidden'); onSuccess(data.user); return; }
    }

    errEl.style.color = 'var(--danger)';
    errEl.textContent = error?.message ?? 'something went wrong';
    btn.disabled = false;
    btn.textContent = isSignup ? 'create account' : 'sign in';
  };

  btn.addEventListener('click', submit);
  [emailEl, passEl].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));
}
