const { Events, EmbedBuilder, AuditLogEvent } = require('discord.js');
const { MongoClient } = require('mongodb');

const EXECUTOR_DESCONHECIDO = 'Desconhecido';
const MOTIVO_NAO_INFORMADO = 'Não informado';

function criarEmbed({ cor, titulo, descricao, thumb, campos }) {
    const embed = new EmbedBuilder()
        .setColor(cor)
        .setTitle(titulo)
        .setTimestamp();
    if (descricao) embed.setDescription(descricao);
    if (thumb) embed.setThumbnail(thumb);
    if (campos) embed.addFields(campos);
    return embed;
}

async function getRegistroMembrosChannelId(mongoUri) {
    const client = new MongoClient(mongoUri);
    try {
        await client.connect();
        const db = client.db('ignis');
        const canaisDoc = await db.collection('configuracoes').findOne({ _id: 'canais' });
        if (!canaisDoc || !Array.isArray(canaisDoc.categorias)) return null;
        for (const categoria of canaisDoc.categorias) {
            if (!Array.isArray(categoria.canais)) continue;
            const canal = categoria.canais.find(c => c.nome === 'registros-membros');
            if (canal) return canal.id;
        }
        return null;
    } finally {
        await client.close();
    }
}

async function getStatusConfig(mongoUri) {
    const client = new MongoClient(mongoUri);
    try {
        await client.connect();
        const db = client.db('ignis');
        const statusDoc = await db.collection('configuracoes').findOne({ _id: 'status' });
        return statusDoc;
    } finally {
        await client.close();
    }
}

async function getExecutorFromAudit(guild, type, targetId, extraFilter) {
    try {
        const audit = await guild.fetchAuditLogs({ type, limit: 5 });
        let entry = audit.entries.find(e => e.target.id === targetId);
        if (extraFilter) entry = audit.entries.find(e => e.target.id === targetId && extraFilter(e));
        return entry && entry.executor ? entry.executor.tag : EXECUTOR_DESCONHECIDO;
    } catch {
        return EXECUTOR_DESCONHECIDO;
    }
}

async function getMotivoFromAudit(guild, type, targetId, extraFilter) {
    try {
        const audit = await guild.fetchAuditLogs({ type, limit: 5 });
        let entry = audit.entries.find(e => e.target.id === targetId);
        if (extraFilter) entry = audit.entries.find(e => e.target.id === targetId && extraFilter(e));
        return entry && entry.reason ? entry.reason : MOTIVO_NAO_INFORMADO;
    } catch {
        return MOTIVO_NAO_INFORMADO;
    }
}

module.exports = {
    name: 'ready',
    once: true,
    async execute(client) {
        const mongoUri = process.env.MONGO_URI;
        const statusConfig = await getStatusConfig(mongoUri);
        async function getLogChannel(guild) {
            const canalId = await getRegistroMembrosChannelId(mongoUri);
            if (!canalId) return null;
            const channel = guild.channels.cache.get(canalId);
            if (!channel || !channel.isTextBased?.() || !channel.viewable || !channel.permissionsFor(guild.members.me).has('SendMessages')) {
                return null;
            }
            return channel;
        }

        client.on(Events.GuildMemberAdd, async member => {
            const logChannel = await getLogChannel(member.guild);
            if (!logChannel) return;
            const embed = criarEmbed({
                cor: member.user.bot ? 0x5865F2 : 0x57F287,
                titulo: member.user.bot ? '🤖 Bot entrou' : '👤 Membro entrou',
                descricao: `${member.user.tag} (${member.id}) entrou no servidor.`,
                thumb: member.user.displayAvatarURL({ dynamic: true })
            });
            logChannel.send({ embeds: [embed] });
        });

        client.on(Events.GuildMemberRemove, async member => {
            const logChannel = await getLogChannel(member.guild);
            if (!logChannel) return;
            let titulo = member.user.bot ? '🤖 Bot saiu' : '👤 Membro saiu';
            let descricao = `${member.user.tag} (${member.id}) saiu do servidor.`;
            try {
                const audit = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 1 });
                const kick = audit.entries.first();
                if (kick && kick.target.id === member.id && Date.now() - kick.createdTimestamp < 5000) {
                    titulo = member.user.bot ? '🤖 Bot expulso' : '👤 Membro expulso';
                    descricao = `${member.user.tag} (${member.id}) foi expulso do servidor por ${kick.executor.tag}.\nMotivo: ${kick.reason || MOTIVO_NAO_INFORMADO}`;
                }
            } catch {}
            const embed = criarEmbed({
                cor: member.user.bot ? 0x5865F2 : 0xED4245,
                titulo,
                descricao,
                thumb: member.user.displayAvatarURL({ dynamic: true })
            });
            logChannel.send({ embeds: [embed] });
        });

        client.on(Events.GuildBanAdd, async ban => {
            const logChannel = await getLogChannel(ban.guild);
            if (!logChannel) return;
            const executor = await getExecutorFromAudit(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
            const motivo = await getMotivoFromAudit(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
            const embed = criarEmbed({
                cor: 0xED4245,
                titulo: '🚫 Usuário Banido',
                descricao: `${ban.user.tag} (${ban.user.id}) foi banido.\nPor: ${executor}\nMotivo: ${motivo}`,
                thumb: ban.user.displayAvatarURL({ dynamic: true })
            });
            logChannel.send({ embeds: [embed] });
        });

        client.on(Events.GuildBanRemove, async ban => {
            const logChannel = await getLogChannel(ban.guild);
            if (!logChannel) return;
            const executor = await getExecutorFromAudit(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
            const embed = criarEmbed({
                cor: 0x57F287,
                titulo: '♻️ Usuário Desbanido',
                descricao: `${ban.user.tag} (${ban.user.id}) foi desbanido.\nPor: ${executor}`,
                thumb: ban.user.displayAvatarURL({ dynamic: true })
            });
            logChannel.send({ embeds: [embed] });
        });

        client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
            if (newMember.user.bot) return;
            const logChannel = await getLogChannel(newMember.guild);
            if (!logChannel) return;
            const added = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
            const removed = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id));
            if (added.size || removed.size) {
                const executor = await getExecutorFromAudit(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
                const campos = [];
                if (added.size) campos.push({ name: 'Cargos Adicionados', value: added.map(r => `<@&${r.id}>`).join(', '), inline: false });
                if (removed.size) campos.push({ name: 'Cargos Removidos', value: removed.map(r => `<@&${r.id}>`).join(', '), inline: false });
                campos.push({ name: 'Alterado por', value: executor, inline: false });
                const embed = criarEmbed({
                    cor: 0xFFA500,
                    titulo: '🔄 Atualização de Cargos',
                    thumb: newMember.user.displayAvatarURL({ dynamic: true }),
                    campos
                });
                logChannel.send({ embeds: [embed] });
            }
            if (!oldMember.communicationDisabledUntil && newMember.communicationDisabledUntil) {
                const executor = await getExecutorFromAudit(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id, e => e.changes.some(c => c.key === 'communication_disabled_until'));
                const motivo = await getMotivoFromAudit(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id, e => e.changes.some(c => c.key === 'communication_disabled_until'));
                const embed = criarEmbed({
                    cor: 0xED4245,
                    titulo: '⏳ Timeout aplicado',
                    descricao: `${newMember.user.tag} (${newMember.id}) recebeu timeout até <t:${Math.floor(new Date(newMember.communicationDisabledUntil).getTime()/1000)}:F>.\nPor: ${executor}\nMotivo: ${motivo}`,
                    thumb: newMember.user.displayAvatarURL({ dynamic: true })
                });
                logChannel.send({ embeds: [embed] });
            }
            if (oldMember.communicationDisabledUntil && !newMember.communicationDisabledUntil) {
                const executor = await getExecutorFromAudit(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id, e => e.changes.some(c => c.key === 'communication_disabled_until' && c.old !== null && c.new === null));
                const embed = criarEmbed({
                    cor: 0x57F287,
                    titulo: '⏳ Timeout removido',
                    descricao: `${newMember.user.tag} (${newMember.id}) teve o timeout removido.\nPor: ${executor}`,
                    thumb: newMember.user.displayAvatarURL({ dynamic: true })
                });
                logChannel.send({ embeds: [embed] });
            }
            if (oldMember.nickname !== newMember.nickname) {
                const executor = await getExecutorFromAudit(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id, e => e.changes.some(c => c.key === 'nick'));
                const embed = criarEmbed({
                    cor: 0xFFA500,
                    titulo: '✏️ Apelido alterado',
                    descricao: `De: ${oldMember.nickname || 'Nenhum'}\nPara: ${newMember.nickname || 'Nenhum'}\nPor: ${executor}`,
                    thumb: newMember.user.displayAvatarURL({ dynamic: true })
                });
                logChannel.send({ embeds: [embed] });
            }
        });

        client.on(Events.UserUpdate, async (oldUser, newUser) => {
            if (newUser.bot) return;
            const changedUsername = oldUser.username !== newUser.username || oldUser.discriminator !== newUser.discriminator;
            const changedAvatar = oldUser.avatar !== newUser.avatar;
            if (!changedUsername && !changedAvatar) return;
            for (const guild of client.guilds.cache.values()) {
                const member = guild.members.cache.get(newUser.id);
                if (!member) continue;
                const logChannel = await getLogChannel(guild);
                if (!logChannel) continue;
                const campos = [];
                if (changedUsername) campos.push({ name: 'Nome de usuário alterado', value: `De: ${oldUser.tag}\nPara: ${newUser.tag}` });
                if (changedAvatar) campos.push({ name: 'Avatar alterado', value: `[Ver novo avatar](${newUser.displayAvatarURL({ dynamic: true })})` });
                const embed = criarEmbed({
                    cor: 0xFFA500,
                    titulo: '📝 Perfil atualizado',
                    descricao: `Usuário: ${newUser.tag} (${newUser.id})`,
                    thumb: newUser.displayAvatarURL({ dynamic: true }),
                    campos
                });
                logChannel.send({ embeds: [embed] });
            }
        });

        client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
            const member = newState.member || oldState.member;
            if (!member || member.user.bot) return;
            const logChannel = await getLogChannel(newState.guild);
            if (!logChannel) return;
            if (!oldState.channel && newState.channel) {
                const embed = criarEmbed({
                    cor: parseInt(statusConfig.colors.positive.replace('#', ''), 16),
                    titulo: `${statusConfig.emojis.create} Entrou em canal de voz`,
                    descricao: `**Usuário:** <@${member.id}>\n**Canal:** ${newState.channel.toString()}`
                });
                logChannel.send({ embeds: [embed] });
            } else if (oldState.channel && !newState.channel) {
                const embed = criarEmbed({
                    cor: parseInt(statusConfig.colors.negative.replace('#', ''), 16),
                    titulo: `${statusConfig.emojis.delete} Saiu do canal de voz`,
                    descricao: `**Usuário:** <@${member.id}>\n**Canal:** ${oldState.channel.toString()}`
                });
                logChannel.send({ embeds: [embed] });
            } else if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
                await new Promise(res => setTimeout(res, 700));
                let executor = null;
                try {
                    const audit = await newState.guild.fetchAuditLogs({ type: AuditLogEvent.MemberMove, limit: 10 });
                    const entry = audit.entries
                        .filter(e => e && e.target && e.executor && e.target.id === member.id && Date.now() - e.createdTimestamp < 5000)
                        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
                    if (entry && entry.executor && entry.executor.id !== member.id) executor = entry.executor;
                } catch (err) {
                    console.error('[LOG] Erro ao buscar audit log de MemberMove:', err);
                }
                const titulo = `${statusConfig.emojis.move} Moveu-se de canal de voz`;
                const descricao = `**Usuário:** <@${member.id}>\n**Canal anterior:** ${oldState.channel.toString()}\n**Canal próximo:** ${newState.channel.toString()}`;
                const embed = criarEmbed({
                    cor: parseInt(statusConfig.colors.change.replace('#', ''), 16),
                    titulo,
                    descricao
                });
                logChannel.send({ embeds: [embed] });
            }
        });
    }
};