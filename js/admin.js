// Panneau admin : liste des utilisateurs, générations et coût estimé, création de comptes.
// Réservé aux comptes admin/manager (table app_roles) — la fonction admin-stats refuse les autres.

const AdminPanel = (() => {
  const el = id => document.getElementById(id);
  const COUT_PAR_GENERATION = 0.10; // € — base volontairement large (réel ≈ 0,09 € en 2K)

  const euros = n => (n * COUT_PAR_GENERATION).toFixed(2).replace(".", ",") + " €";
  const dateFr = iso => (iso ? new Date(iso).toLocaleDateString("fr-FR") : "—");

  async function callFn(name, body) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error("Session expirée, reconnecte-toi.");
    const resp = await fetch(SUPABASE_URL + "/functions/v1/" + name, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + session.access_token,
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body || {}),
    });
    const out = await resp.json();
    if (!resp.ok) throw new Error(out.error || ("Erreur " + resp.status));
    return out;
  }

  async function refresh() {
    const msg = el("admin-msg");
    msg.className = "msg";
    msg.textContent = "Chargement…";
    const tbody = el("admin-table").querySelector("tbody");
    const tfoot = el("admin-table").querySelector("tfoot");
    try {
      const { users } = await callFn("admin-stats");
      users.sort((a, b) => b.generations_mois - a.generations_mois || b.generations_total - a.generations_total);
      tbody.innerHTML = "";
      let totMois = 0, totAll = 0;
      for (const u of users) {
        totMois += u.generations_mois;
        totAll += u.generations_total;
        const tr = document.createElement("tr");
        for (const val of [
          u.email,
          u.generations_mois,
          euros(u.generations_mois),
          u.generations_total,
          euros(u.generations_total),
          dateFr(u.derniere_generation),
          dateFr(u.derniere_connexion),
        ]) {
          const td = document.createElement("td");
          td.textContent = String(val);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      tfoot.innerHTML = "";
      const tr = document.createElement("tr");
      for (const val of ["Total", totMois, euros(totMois), totAll, euros(totAll), "", ""]) {
        const td = document.createElement("td");
        td.textContent = String(val);
        tr.appendChild(td);
      }
      tfoot.appendChild(tr);
      msg.textContent = "";
    } catch (e) {
      tbody.innerHTML = "";
      tfoot.innerHTML = "";
      msg.className = "msg error";
      msg.textContent = e.message || String(e);
    }
  }

  async function addUser(ev) {
    ev.preventDefault();
    const msg = el("admin-msg");
    msg.className = "msg";
    msg.textContent = "Création du compte…";
    try {
      await callFn("admin-create-user", {
        email: el("new-user-email").value.trim(),
        password: el("new-user-password").value,
        make_admin: el("new-user-admin").checked,
      });
      el("form-add-user").reset();
      msg.className = "msg ok";
      msg.textContent = "Compte créé — il peut se connecter immédiatement.";
      await refresh();
    } catch (e) {
      msg.className = "msg error";
      msg.textContent = e.message || String(e);
    }
  }

  function wire() {
    el("btn-admin").addEventListener("click", () => {
      el("admin-panel").classList.remove("hidden");
      refresh();
    });
    el("btn-admin-close").addEventListener("click", () => el("admin-panel").classList.add("hidden"));
    el("btn-admin-refresh").addEventListener("click", refresh);
    el("form-add-user").addEventListener("submit", addUser);
  }

  document.addEventListener("DOMContentLoaded", wire);
  return { refresh };
})();
