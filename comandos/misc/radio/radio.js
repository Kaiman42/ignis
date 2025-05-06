const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource } = require('@discordjs/voice');
const mongodb = require('../../../configuracoes/mongodb');
const { RadioError, ErrorMessages, handleRadioError } = require('./erros');
const { LIMITS, validateRadioSelection, getPageLimits } = require('./limites');
const { checkRadioPermissions, getChannels } = require('./permissoes');
const { 
    players, 
    connections, 
    radioMessages, 
    radioOwners, 
    setupEmptyCheck, 
    clearRadioState 
} = require('./estado');

async function loadRadios() {
    try {
        const radiosDoc = await mongodb.findOne(mongodb.COLLECTIONS.CONFIGURACOES, { _id: 'radios' });
        if (!radiosDoc) return {};
        const { _id, ...radiosData } = radiosDoc;
        return radiosData;
    } catch (error) {
        console.error('Erro ao carregar rádios:', error);
        return {};
    }
}

async function playRadio(interaction, country, radioIndex) {
    try {
        const radios = await loadRadios();
        const radio = validateRadioSelection(radios, country, radioIndex);
        
        const voiceChannel = interaction.member.voice.channel;
        const guildId = interaction.guild.id;
        
        let connection = connections.get(guildId);
        if (!connection) {
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
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
            connection.subscribe(player);
        }
        
        const resource = createAudioResource(radio.url, {
            inlineVolume: true,
        });
        resource.volume?.setVolume(LIMITS.DEFAULT_VOLUME);
        player.play(resource);
        
        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle(`🎵 Rádio: ${radio.name}`)
            .setDescription(radio.description || 'Sem descrição')
            .addFields(
                { name: '📍 Local', value: radio.place || 'Desconhecido' },
                { name: '🎧 Canal', value: `<#${voiceChannel.id}>` },
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
        setupEmptyCheck(guildId, voiceChannel.id, interaction.client);
        
        return true;
    } catch (error) {
        await handleRadioError(error, interaction);
        return false;
    }
}

async function stopRadio(guildId, interaction, skipMessage = false) {
    try {
        clearRadioState(guildId);
        
        if (interaction && !skipMessage) {
            await interaction.followUp({
                content: '✅ Rádio desconectada com sucesso!',
                ephemeral: true
            });
        }
        
        return true;
    } catch (error) {
        if (interaction && !skipMessage) {
            await handleRadioError(error, interaction);
        }
        return false;
    }
}

async function navigateRadios(interaction, direction) {
    try {
        const guildId = interaction.guild.id;
        const currentMessage = radioMessages.get(guildId);
        
        if (!currentMessage?.embeds?.[0]) {
            throw new RadioError(ErrorMessages.NO_RADIO_PLAYING);
        }
        
        const footerText = currentMessage.embeds[0].footer?.text || '';
        const match = footerText.match(/Rádio (\d+)\/\d+ de (.+)/);
        
        if (!match) {
            throw new RadioError(ErrorMessages.NO_RADIO_PLAYING);
        }
        
        const currentIndex = parseInt(match[1]) - 1;
        const country = match[2];
        
        const radios = await loadRadios();
        const countryRadios = radios[country];
        
        const newIndex = direction === 'next' 
            ? (currentIndex + 1) % countryRadios.length
            : (currentIndex - 1 + countryRadios.length) % countryRadios.length;
        
        return await playRadio(interaction, country, newIndex);
    } catch (error) {
        await handleRadioError(error, interaction);
        return false;
    }
}

async function handleCountrySelect(interaction) {
    try {
        await checkRadioPermissions(interaction);
        const country = interaction.values[0];
        const radios = await loadRadios();
        const countryRadios = radios[country];
        
        const guildId = interaction.guild.id;
        const currentMessage = radioMessages.get(guildId);
        
        if (currentMessage && radioOwners.get(guildId) === interaction.user.id) {
            await playRadio(interaction, country, 0);
            return;
        }
        
        const { end: maxRadios } = getPageLimits(countryRadios.length);
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
        for (let i = 0; i < buttons.length; i += LIMITS.MAX_RADIOS_PER_PAGE) {
            rows.push(
                new ActionRowBuilder().addComponents(
                    ...buttons.slice(i, Math.min(i + LIMITS.MAX_RADIOS_PER_PAGE, buttons.length))
                )
            );
        }
        
        await interaction.editReply({
            content: `📻 Selecione uma rádio de ${country}:`,
            components: rows
        });
    } catch (error) {
        await handleRadioError(error, interaction);
    }
}

async function handleButton(interaction) {
    try {
        await checkRadioPermissions(interaction);
        const customId = interaction.customId;
        const guildId = interaction.guild.id;

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferUpdate();
        }

        if (customId === 'radio_stop') {
            await stopRadio(guildId, interaction);
        } else if (customId.startsWith('radio_play_')) {
            const [, , country, index] = customId.split('_');
            await playRadio(interaction, country, parseInt(index));
        } else if (customId === 'radio_back') {
            await module.exports.execute(interaction);
        } else if (customId === 'radio_next') {
            await navigateRadios(interaction, 'next');
        } else if (customId === 'radio_prev') {
            await navigateRadios(interaction, 'prev');
        }
    } catch (error) {
        await handleRadioError(error, interaction);
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('radio')
        .setDescription('Toca uma rádio no canal de voz dedicado'),
    
    async execute(interaction) {
        try {
            await interaction.deferReply();
            await checkRadioPermissions(interaction);
            
            const radios = await loadRadios();
            const countries = Object.keys(radios)
                .filter(c => Array.isArray(radios[c]) && radios[c].length > 0);
            
            if (countries.length === 0) {
                throw new RadioError('❌ Nenhuma rádio encontrada. Contate um administrador para configurar rádios.');
            }
            
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('radio_country_select')
                    .setPlaceholder('Escolha um país')
                    .addOptions(countries.map(country => ({
                        label: country,
                        description: `${radios[country].length} rádios disponíveis`,
                        value: country
                    })))
            );
            
            await interaction.editReply({
                content: '📻 Selecione um país para ver as rádios disponíveis:',
                components: [row]
            });
        } catch (error) {
            await handleRadioError(error, interaction);
        }
    },
    
    handleButton,
    handleCountrySelect
};