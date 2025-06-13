const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { gerarCorAleatoria } = require('../../configuracoes/randomColor');
const { getRegistroMembrosChannelId } = require('../../mongodb');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('parceria')
        .setDescription('Exibe os requisitos para a formação de uma parceria.'),
    async execute(interaction) {
        const mongoUri = process.env.MONGO_URI;
        const { user, guild } = interaction;
        let cor = gerarCorAleatoria();
        try {
            const canalId = await getRegistroMembrosChannelId(mongoUri);
            if (canalId) {
                const canal = guild.channels.cache.get(canalId) || await guild.channels.fetch(canalId).catch(() => null);
                if (canal && canal.isTextBased?.() && canal.viewable && canal.permissionsFor(guild.members.me).has('SendMessages')) {
                    const embed = new EmbedBuilder()
                        .setColor(cor)
                        .setTitle(`${user.username} usou`)
                        .setDescription(`Usuário usou o comando \`/parceria\``)
                        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 512 }))
                        .setTimestamp();
                    await canal.send({ embeds: [embed] });
                }
            }
        } catch (e) {
            console.error('Erro ao notificar canal registros-membros:', e);
        }

        const button = new ButtonBuilder()
            .setCustomId('notificar_responsavel')
            .setLabel('📥 Notificar Responsável')
            .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(button);

        await interaction.reply({
            content: `**Requisitos para a formação de uma parceria:**
1. Ter um servidor, de pelo menos 50 membros.
2. Seguir as regras do Discord.
3. Oferecer reciprocidade na divulgação.
4. Estar disposto a manter uma comunicação aberta.

Clique no botão abaixo e notifique sua intenção de parceria e você será respondido em breve.`,
            components: [row],
            flags: 'Ephemeral'
        });

        const collector = interaction.channel.createMessageComponentCollector({
            filter: i => i.customId === 'notificar_responsavel' && i.user.id === interaction.user.id,
            time: 60000,
            max: 1
        });

        collector.on('collect', async i => {
            const disabledRow = new ActionRowBuilder()
                .addComponents(ButtonBuilder.from(button).setDisabled(true));

            try {
                const responsavel = await interaction.client.users.fetch('1199908820135194677');
                const { user, member } = interaction;

                const campos = [
                    { name: '📋 Nome', value: user.username, inline: true },
                    { name: '🆔 ID', value: user.id, inline: true },
                    { name: '📅 Conta Criada', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
                    member?.joinedTimestamp ? {
                        name: '📥 Entrou no Servidor',
                        value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`,
                        inline: true
                    } : null
                ].filter(Boolean);

                const embed = new EmbedBuilder()
                    .setColor(0x4B0082)
                    .setTitle('Nova Solicitação de Parceria')
                    .setAuthor({ name: user.username, iconURL: user.displayAvatarURL({ dynamic: true }) })
                    .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 512 }))
                    .setDescription(`O usuário [${user.username}](https://discord.com/users/${user.id}) solicitou informações sobre parceria.`)
                    .addFields(...campos)
                    .setTimestamp();

                await responsavel.send({ embeds: [embed] });
                await i.update({ content: 'O responsável foi notificado com sucesso!', components: [disabledRow] });
            } catch (err) {
                console.error('Erro ao notificar responsável:', err); // Adicionado log detalhado
                await i.update({ content: 'Não foi possível notificar o responsável.', components: [disabledRow] });
            }
        });
    }
};