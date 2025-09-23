const LOCALS = ['X6','X5','CTR','Pial','Ofc','Com','VV'];
let perfil = null;

function agoraBrasilia() {
    const agora = new Date();
    const utc = agora.getTime() + (agora.getTimezoneOffset()*60000);
    return new Date(utc + (-3*3600000));
}

window.addEventListener('load', async () => {
    await carregarPessoas();
    setInterval(atualizarTudo, 1000);
});

async function carregarPessoas() {
    const res = await fetch('/pessoas', {credentials:'include'});
    if(!res.ok){ if(res.status===401) window.location.href='/login.html'; return; }
    const data = await res.json();
    perfil = data.perfil;

    const tbody = document.querySelector('#tabelaPessoas tbody');
    tbody.innerHTML = '';

    montarTabela(data.pessoas);
}

function montarTabela(pessoas){
    pessoas.sort((a,b)=>a.id-b.id);
    const tbody = document.querySelector('#tabelaPessoas tbody');
    tbody.innerHTML='';
    pessoas.forEach(p=>{
        const tr = document.createElement('tr');
        tr.innerHTML=`
            <td style="text-align:center;">${p.status}</td>
            <td>${p.nome}</td>
            <td>${p.local}</td>
            <td>${p.hora_inicial||''}</td>
            <td>${p.hora_final||''}</td>
            <td>
                <button onclick="abrirPerfil(${p.id})" class="btn btn-sm btn-info">Perfil</button>
                <button onclick="iniciarPessoa(${p.id})" class="btn btn-sm btn-warning">Iniciar</button>
                <button onclick="excluirPessoa(${p.id})" class="btn btn-sm btn-danger">Excluir</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// --- Perfil ---
async function abrirPerfil(id){
    const res = await fetch('/pessoas', {credentials:'include'});
    const data = await res.json();
    const pessoa = data.pessoas.find(p=>p.id===id);
    if(!pessoa) return;

    const container = document.getElementById('perfilConteudo');
    container.innerHTML='';

    const card = document.createElement('div');
    card.className='perfil-card';

    card.innerHTML=`
        <div class="perfil-header">
            <strong>${pessoa.nome}</strong>
            <span class="perfil-status">${pessoa.status}</span>
        </div>
        <div class="perfil-info">
            <label>Local</label>
            <input value="${pessoa.local}" onchange="atualizarCampo(${id},'local',this.value)">

            <label>Hora Início</label>
            <input type="time" value="${pessoa.hora_inicial||''}" onchange="editarHorario(${id}, this.value)">

            <label>Hora Fim</label>
            <input type="time" value="${pessoa.hora_final||''}" disabled>

            <label>Mensagem</label>
            <textarea onchange="atualizarCampo(${id},'mensagem',this.value)">${pessoa.mensagem||''}</textarea>

            <label>Justificativa</label>
            <textarea onchange="atualizarCampo(${id},'justificativa',this.value)">${pessoa.justificativa||''}</textarea>

        
        </div>
    `;

    container.appendChild(card);
    const modal = new bootstrap.Modal(document.getElementById('modalPerfil'));
    modal.show();
}

// --- Funções ---
async function atualizarCampo(id,campo,valor){
    await fetch('/pessoa/update',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id,campo,valor}),
        credentials:'include'
    });
    await carregarPessoas();
}

async function editarHorario(id, hora_inicial){
    const res = await fetch('/pessoa/editarHorario',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id,hora_inicial}),
        credentials:'include'
    });
    await carregarPessoas();
}

async function iniciarPessoa(id){
    await fetch('/pessoa/iniciar',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id}),
        credentials:'include'
    });
    await carregarPessoas();
}

async function excluirPessoa(id){
    if(!confirm('Deseja realmente excluir?')) return;
    await fetch('/pessoa/excluir',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id}),
        credentials:'include'
    });
    await carregarPessoas();
}

async function atualizarTudo(){
    await carregarPessoas();
}
