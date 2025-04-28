const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const mongodb = require('../../configuracoes/mongodb');

const players = new Map();
const connections = new Map();
const radioMessages = new Map();
const radioOwners = new Map();
const disconnectTimers = new Map();
const DISCONNECT_TIMEOUT = 60000;

function setupDisconnectTimer(guildId, radioChannelId, client) {
    if (disconnectTimers.has(guildId)) {
        clearInterval(disconnectTimers.get(guildId));
    }
    
    const timer = setInterval(async () => {
        try {
            const guild = client.guilds.cache.get(guildId);
            if (!guild) return;
            
            const channel = guild.channels.cache.get(radioChannelId);
            if (!channel) return;
            
            const members = channel.members.filter(member => !member.user.bot);
            
            if (members.size === 0) {
                console.log(`Canal de rádio ${radioChannelId} está vazio. Desconectando em 15 segundos...`);
                
                setTimeout(async () => {
                    try {
                        const refreshedChannel = await guild.channels.fetch(radioChannelId);
                        const refreshedMembers = refreshedChannel.members.filter(member => !member.user.bot);
                        
                        if (refreshedMembers.size === 0) {
                            console.log('Canal continua vazio. Desconectando rádio...');
                            await stopRadio(guildId);
                            
                            try {
                                const channels = await getChannels(guildId);
                                if (channels?.botChannelId) {
                                    const botChannel = await guild.channels.fetch(channels.botChannelId);
                                    await botChannel.send('📻 A rádio foi desligada automaticamente por inatividade.');
                                }
                            } catch (notifyError) {
                                console.error('Erro ao notificar desconexão automática:', notifyError);
                            }
                        }
                    } catch (error) {
                        console.error('Erro ao verificar canal para desconexão automática:', error);
                    }
                }, 15000);
            }
        } catch (error) {
            console.error('Erro no timer de desconexão automática:', error);
        }
    }, 15000);
    
    disconnectTimers.set(guildId, timer);
}

async function loadRadios() {
    try {
        const radiosDoc = await mongodb.findOne(mongodb.COLLECTIONS.CONFIGURACOES, { _id: 'radios' });
        
        if (!radiosDoc) {
            return {};
        }
        
        const { _id, ...radiosData } = radiosDoc;
        return radiosData;
    } catch (error) {
        console.error('Erro ao carregar rádios:', error);
        return {};
    }
}

async function getChannels(guildId) {
    try {
        const configDoc = await mongodb.findOne(mongodb.COLLECTIONS.CONFIGURACOES, { _id: 'canais' });
        
        if (!configDoc || !configDoc.categorias) {
            return null;
        }
        
        let botChannelId = null;
        
        for (const categoria of configDoc.categorias) {
            if (!categoria.canais) continue;
            
            for (const canal of categoria.canais) {
                if (canal.nome === 'bot') {
                    botChannelId = canal.id;
                    break;
                }
            }
            if (botChannelId) break;
        }
        
        return { botChannelId };
    } catch (error) {
        console.error('Erro ao buscar canal de bot:', error);
        return null;
    }
}

async function hasDjRole(member) {
    try {
        const configDoc = await mongodb.findOne(mongodb.COLLECTIONS.CONFIGURACOES, { _id: 'escopos' });
        
        if (!configDoc?.cargos?.dj) {
            return true;
        }
        
        return member.roles.cache.has(configDoc.cargos.dj.id);
    } catch (error) {
        console.error('Erro ao verificar cargo DJ:', error);
        return true;
    }
}

async function playRadio(interaction, country, radioIndex) {
    try {
        const radios = await loadRadios();
        
        if (!radios[country] || !Array.isArray(radios[country])) {
            await interaction.followUp({
                content: `❌ País não encontrado: ${country}`,
                flags: 'Ephemeral'
            });
            return;
        }
        
        if (radioIndex < 0 || radioIndex >= radios[country].length) {
            await interaction.followUp({
                content: `❌ Rádio não encontrada (índice ${radioIndex})`,
                flags: 'Ephemeral'
            });
            return;
        }
        
        if (interaction.message && !interaction.customId.startsWith('radio_next') && 
            !interaction.customId.startsWith('radio_prev')) {
            try {
                await interaction.message.delete();
            } catch (error) {
                console.error('Erro ao excluir mensagem de seleção:', error);
            }
        }
        
        const radio = radios[country][radioIndex];
        
        if (!radio.url) {
            await interaction.followUp({
                content: `❌ URL inválida para a rádio ${radio.name}`,
                flags: 'Ephemeral'
            });
            return;
        }
        
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
            await interaction.followUp({
                content: `❌ Você precisa estar em um canal de voz para usar este comando`,
                flags: 'Ephemeral'
            });
            return;
        }
        
        const guildId = interaction.guild.id;
        const voiceChannelId = voiceChannel.id;
        
        let connection = connections.get(guildId);
        if (!connection) {
            connection = joinVoiceChannel({
                channelId: voiceChannelId,
                guildId: guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
            });
            
            connections.set(guildId, connection);
            radioOwners.set(guildId, interaction.user.id);
        }
        
        let player = players.get(guildId);
        if (!player) {
            player = createAudioPlayer();
            players.set(guildId, player);
            
            player.on(AudioPlayerStatus.Idle, () => {});
            
            player.on('error', error => {
                console.error(`Erro no player para ${guildId}:`, error);
                interaction.followUp({
                    content: `❌ Erro ao reproduzir rádio: ${error.message}`,
                    flags: 'Ephemeral'
                }).catch(console.error);
            });
            
            connection.subscribe(player);
        }
        
        const resource = createAudioResource(radio.url, {
            inlineVolume: true,
        });
        resource.volume?.setVolume(0.5);
        
        player.play(resource);
        
        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle(`🎵 Rádio: ${radio.name}`)
            .setDescription(radio.description || 'Sem descrição')
            .addFields(
                { name: '📍 Local', value: radio.place || 'Desconhecido' },
                { name: '🎧 Canal', value: `<#${voiceChannelId}>` },
                { name: '🎭 DJ', value: `<@${radioOwners.get(guildId)}>` }
            )
            .setFooter({ text: `Rádio ${radioIndex + 1}/${radios[country].length} de ${country}` })
            .setTimestamp();
        
        const countries = Object.keys(radios).filter(c => Array.isArray(radios[c]) && radios[c].length > 0);
        
        const countryMenu = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('radio_country_select')
                .setPlaceholder('Mudar país')
                .addOptions(countries.map(c => ({
                    label: c,
                    description: `${radios[c].length} rádios disponíveis`,
                    value: c,
                    default: c === country
                })))
        );
        
        const controlButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('radio_prev')
                .setLabel('⏮️ Anterior')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('radio_stop')
                .setLabel('⏹️ Parar')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('radio_next')
                .setLabel('⏭️ Próxima')
                .setStyle(ButtonStyle.Secondary)
        );
        
        const oldMessage = radioMessages.get(guildId);
        if (oldMessage) {
            try {
                await oldMessage.delete();
            } catch (error) {}
        }
        
        const message = await interaction.followUp({
            embeds: [embed],
            components: [countryMenu, controlButtons],
            fetchReply: true
        });
        
        radioMessages.set(guildId, message);
        
        setupDisconnectTimer(guildId, voiceChannelId, interaction.client);
        
        return true;
    } catch (error) {
        console.error('Erro ao reproduzir rádio:', error);
        await interaction.followUp({
            content: `❌ Erro ao reproduzir rádio: ${error.message}`,
            flags: 'Ephemeral'
        });
        return false;
    }
}

async function stopRadio(guildId, interaction) {
    try {
        const player = players.get(guildId);
        if (player) {
            player.stop();
            players.delete(guildId);
        }
        
        const connection = connections.get(guildId);
        if (connection) {
            connection.destroy();
            connections.delete(guildId);
        }
        
        radioOwners.delete(guildId);
        
        const message = radioMessages.get(guildId);
        if (message) {
            try {
                await message.delete();
            } catch (error) {}
            
            radioMessages.delete(guildId);
        }
        
        if (disconnectTimers.has(guildId)) {
            clearInterval(disconnectTimers.get(guildId));
            disconnectTimers.delete(guildId);
        }
        
        if (interaction) {
            await interaction.followUp({
                content: '✅ Rádio desconectada com sucesso!',
                flags: 'Ephemeral'
            });
        }
        
        return true;
    } catch (error) {
        console.error('Erro ao desconectar rádio:', error);
        
        if (interaction) {
            await interaction.followUp({
                content: `❌ Erro ao desconectar rádio: ${error.message}`,
                flags: 'Ephemeral'
            });
        }
        
        return false;
    }
}

async function navigateRadios(interaction, direction) {
    try {
        const guildId = interaction.guild.id;
        
        const currentMessage = radioMessages.get(guildId);
        if (!currentMessage || !currentMessage.embeds || currentMessage.embeds.length === 0) {
            await interaction.followUp({
                content: `❌ Não há rádio em execução no momento`,
                flags: 'Ephemeral'
            });
            return false;
        }
        
        const currentEmbed = currentMessage.embeds[0];
        const footerText = currentEmbed.footer?.text || '';
        const match = footerText.match(/Rádio (\d+)\/\d+ de (.+)/);
        
        if (!match) {
            await interaction.followUp({
                content: `❌ Não foi possível determinar a rádio atual`,
                flags: 'Ephemeral'
            });
            return false;
        }
        
        const currentIndex = parseInt(match[1]) - 1;
        const country = match[2];
        
        const radios = await loadRadios();
        if (!radios[country] || !Array.isArray(radios[country])) {
            await interaction.followUp({
                content: `❌ País não encontrado: ${country}`,
                flags: 'Ephemeral'
            });
            return false;
        }
        
        const countryRadios = radios[country];
        
        let newIndex;
        if (direction === 'next') {
            newIndex = (currentIndex + 1) % countryRadios.length;
        } else {
            newIndex = (currentIndex - 1 + countryRadios.length) % countryRadios.length;
        }
        
        return await playRadio(interaction, country, newIndex);
    } catch (error) {
        console.error('Erro ao navegar entre rádios:', error);
        await interaction.followUp({
            content: `❌ Erro ao navegar entre rádios: ${error.message}`,
            flags: 'Ephemeral'
        });
        return false;
    }
}

async function checkRadioPermissions(interaction) {
    const isDj = await hasDjRole(interaction.member);
    if (!isDj) {
        await interaction.reply({
            content: '❌ Você precisa ter o cargo de DJ para usar este comando.',
            flags: 'Ephemeral'
        });
        return false;
    }
    
    const channels = await getChannels(interaction.guild.id);
    if (!channels) {
        await interaction.reply({
            content: '❌ Configuração de canais não encontrada.',
            flags: 'Ephemeral'
        });
        return false;
    }
    
    if (!channels.botChannelId) {
        await interaction.reply({
            content: '❌ O canal "bot" não foi encontrado na configuração.',
            flags: 'Ephemeral'
        });
        return false;
    }
    
    if (interaction.channel.id !== channels.botChannelId) {
        await interaction.reply({
            content: `❌ Este comando só pode ser usado no canal <#${channels.botChannelId}>.`,
            flags: 'Ephemeral'
        });
        return false;
    }
    
    if (!interaction.member.voice.channel) {
        await interaction.reply({
            content: '❌ Você precisa estar em um canal de voz para usar este comando.',
            flags: 'Ephemeral'
        });
        return false;
    }
    
    const guildId = interaction.guild.id;
    if (connections.has(guildId) && 
        radioOwners.has(guildId) && 
        radioOwners.get(guildId) !== interaction.user.id) {
        
        await interaction.reply({
            content: `❌ Apenas <@${radioOwners.get(guildId)}> pode controlar a rádio nesta sessão.`,
            flags: 'Ephemeral'
        });
        return false;
    }
    
    return { channels };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('radio')
        .setDescription('Toca uma rádio no canal de voz dedicado'),
    
    async execute(interaction) {
        await interaction.deferReply();
        
        try {
            const permissionCheck = await checkRadioPermissions(interaction);
            if (!permissionCheck) return;
            
            const radios = await loadRadios();
            const countries = Object.keys(radios).filter(c => Array.isArray(radios[c]) && radios[c].length > 0);
            
            if (countries.length === 0) {
                return await interaction.editReply({
                    content: '❌ Nenhuma rádio encontrada. Contate um administrador para configurar rádios.',
                    flags: 'Ephemeral'
                });
            }
            
            const selectOptions = countries.map(country => ({
                label: country,
                description: `${radios[country].length} rádios disponíveis`,
                value: country
            }));
            
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('radio_country_select')
                    .setPlaceholder('Escolha um país')
                    .addOptions(selectOptions)
            );
            
            await interaction.editReply({
                content: '📻 Selecione um país para ver as rádios disponíveis:',
                components: [row]
            });
        } catch (error) {
            console.error('Erro ao executar comando de rádio:', error);
            await interaction.editReply({
                content: `❌ Ocorreu um erro ao executar o comando: ${error.message}`,
                flags: 'Ephemeral'
            });
        }
    },
    
    async handleCountrySelect(interaction) {
        await interaction.deferUpdate();
        
        try {
            if (!(await hasDjRole(interaction.member))) {
                return await interaction.followUp({
                    content: '❌ Você precisa ter o cargo de DJ para usar este comando.',
                    flags: 'Ephemeral'
                });
            }
            
            const guildId = interaction.guild.id;
            
            if (connections.has(guildId) && radioOwners.has(guildId) && 
                radioOwners.get(guildId) !== interaction.user.id) {
                
                return await interaction.followUp({
                    content: `❌ Apenas <@${radioOwners.get(guildId)}> pode controlar a rádio nesta sessão.`,
                    flags: 'Ephemeral'
                });
            }
            
            const country = interaction.values[0];
            
            const radios = await loadRadios();
            
            if (!radios[country] || !Array.isArray(radios[country]) || radios[country].length === 0) {
                return await interaction.followUp({
                    content: `❌ Nenhuma rádio encontrada para ${country}.`,
                    flags: 'Ephemeral'
                });
            }
            
            const countryRadios = radios[country];
            
            const currentMessage = radioMessages.get(guildId);
            if (currentMessage && radioOwners.get(guildId) === interaction.user.id) {
                await playRadio(interaction, country, 0);
                return;
            }
            
            const maxRadios = Math.min(countryRadios.length, 5);
            const buttons = [];
            
            for (let i = 0; i < maxRadios; i++) {
                buttons.push(
                    new ButtonBuilder()
                        .setCustomId(`radio_play_${country}_${i}`)
                        .setLabel(countryRadios[i].name)
                        .setStyle(ButtonStyle.Primary)
                );
            }
            
            buttons.push(
                new ButtonBuilder()
                    .setCustomId('radio_back')
                    .setLabel('⬅️ Voltar')
                    .setStyle(ButtonStyle.Secondary)
            );
            
            const rows = [];
            for (let i = 0; i < buttons.length; i += 5) {
                const row = new ActionRowBuilder().addComponents(
                    ...buttons.slice(i, i + 5)
                );
                rows.push(row);
            }
            
            await interaction.editReply({
                content: `📻 Selecione uma rádio de ${country}:`,
                components: rows
            });
        } catch (error) {
            console.error('Erro ao processar seleção de país:', error);
            await interaction.followUp({
                content: `❌ Ocorreu um erro ao processar sua seleção: ${error.message}`,
                flags: 'Ephemeral'
            });
        }
    },

    async handleButton(interaction) {
        const customId = interaction.customId;
        const guildId = interaction.guild.id;

        try {
            if (!(await hasDjRole(interaction.member))) {
                await interaction.reply({
                    content: '❌ Você precisa ter o cargo de DJ para usar este comando.',
                    flags: 'Ephemeral'
                });
                return;
            }

            if ((customId === 'radio_stop' || customId === 'radio_next' || customId === 'radio_prev') &&
                radioOwners.has(guildId) && radioOwners.get(guildId) !== interaction.user.id) {

                await interaction.reply({
                    content: `❌ Apenas <@${radioOwners.get(guildId)}> pode controlar a rádio nesta sessão.`,
                    flags: 'Ephemeral'
                });
                return;
            }

            await interaction.deferUpdate().catch(console.error);

            if (customId === 'radio_stop') {
                await stopRadio(guildId, interaction);
            } else if (customId.startsWith('radio_play_')) {
                if (connections.has(guildId) && radioOwners.has(guildId) && 
                    radioOwners.get(guildId) !== interaction.user.id) {

                    await interaction.followUp({
                        content: `❌ Apenas <@${radioOwners.get(guildId)}> pode controlar a rádio nesta sessão.`,
                        flags: 'Ephemeral'
                    });
                    return;
                }

                const parts = customId.split('_');
                const country = parts[2];
                const radioIndex = parseInt(parts[3]);

                await playRadio(interaction, country, radioIndex);
            } else if (customId === 'radio_back') {
                await this.execute(interaction);
            } else if (customId === 'radio_next') {
                await navigateRadios(interaction, 'next');
            } else if (customId === 'radio_prev') {
                await navigateRadios(interaction, 'prev');
            }
        } catch (error) {
            console.error('Erro ao processar botão:', error);
            await interaction.followUp({
                content: `❌ Ocorreu um erro ao processar o botão: ${error.message}`,
                flags: 'Ephemeral'
            });
        }
    }
};