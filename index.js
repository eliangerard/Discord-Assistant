const fs = require('fs');
const util = require('util');
const path = require('path');
const { Readable } = require('stream');
const GoogleAssistant = require('google-assistant');
const WavFileWriter = require('wav').FileWriter;
const Discord = require("discord.js");
const witClient = require('node-witai-speech');

const client = new Discord.Client();
client.config = require("./config.json");
const prefix = client.config.prefix;

const loadConfig = () => {
    if (!fs.existsSync("config.json")) {
        client.config.discord_token = process.env.DISCORD_TOK;
        client.config.wit_ai_token = process.env.WITAPIKEY;
    }
    if (!client.config.discord_token || !client.config.wit_ai_token)
        throw 'Fail loading keys, set it at config.json or .env'
}
loadConfig();

client.on('ready', () => {
    console.log(`Bot ${client.user.tag} inicializado`);
});

let texto = false;
let voice_Connection = null;
let message = null;
let recording = false;
let usuario = null;
let waitingForResponse = false;

client.config.assistant = {
    auth: {
      keyFilePath: path.resolve(__dirname, client.config.client_secret_google_dir),
      savedTokensPath: path.resolve(__dirname, './keys/tokens.json'), // where you want the tokens to be saved
    },
    conversation: {
      audio: {
          encodingIn: 'LINEAR16', // supported are LINEAR16 / FLAC (defaults to LINEAR16)
          sampleRateIn: 16000, // supported rates are between 16000-24000 (defaults to 16000)
          encodingOut: 'LINEAR16', // supported are LINEAR16 / MP3 / OPUS_IN_OGG (defaults to LINEAR16)
          sampleRateOut: 24000, // supported are 16000 / 24000 (defaults to 24000)
        },
      lang: client.config.google_lang,
      deviceLocation: {
          coordinates: { // set the latitude and longitude of the device
            latitude: client.config.latitude,
            longitude: client.config.longitude,
          },
        },
      showDebugInfo: false, // default is false, bug good for testing AoG things
    },
};

const startConversation = (conversation) => {
    conversation
      .on('response', text => {
          if(message.member.voice.channel == null && text.length > 0){
            message.channel.send(text); 
            recording = false;
            startRecording = false;
          }
      })
      .on('audio-data', (buffer) => {         
          if(message.member.voice.channel != null){
              if(startRecording){
                  outputFileStream = new WavFileWriter(`./sounds/answer.wav`, {
                      sampleRate: 24000,
                      bitDepth: 16,
                      channels: 1
                    });
                  startRecording = false;
              }          
              outputFileStream.write(buffer);
          }
      })
      // if we've requested a volume level change, get the percentage of the new level
      .on('volume-percent', percent => console.log('New Volume Percent:', percent))
      // the device needs to complete an action
      .on('device-action', action => console.log('Device Action:', action))
      // once the conversation is ended, see if we need to follow up
      .on('ended', (error, continueConversation) => {
        if(!texto){
            voice_Connection.play('./sounds/answer.wav')
            if (outputFileStream) {
                outputFileStream.end();
            }        
        }
        if (error) {
            console.log('Conversation Ended Error:', error);
        } else if (continueConversation) {
            waitingForResponse = true
            recording = false
        } else {
            console.log('Conversation Complete');
            waitingForResponse = false
            conversation.end();                
        }
      })
      .on('error', (error) => {
        console.log('Conversation Error:', error);
      });
};

client.assistant = new GoogleAssistant(client.config.assistant.auth);

client.assistant
.on('ready', () => console.log("Instancia de Google Assistant lista"))
.on('error', (error) => {
    console.log('Assistant Error:', error);
});
const sleep = (ms) => {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
const convertAudio = async (input) => {
    try {
        // stereo to mono channel
        const data = new Int16Array(input)
        const ndata = new Int16Array(data.length/2)
        for (let i = 0, j = 0; i < data.length; i+=4) {
            ndata[j++] = data[i]
            ndata[j++] = data[i+1]
        }
        return Buffer.from(ndata);
    } catch (e) {
        console.log(e)
        console.log('convertAudio: ' + e)
        throw e;
    }
}

client.on('message', async (msg) => {
    
    let partsMsg;

    if (!msg.content.startsWith(prefix) || !msg.guild) return;
    msg.content = msg.content.substring(prefix.length);
    message = msg;
    partsMsg = msg.content.split(' ');
    console.log(partsMsg);
    
    if (partsMsg[0] == "join") {
        if (!msg.member.voice.channelID) {
            return msg.reply('Error: please join a voice channel first.');
        }
        return connect(msg);
    }

    if(partsMsg[0] == "stop" || partsMsg[0] == "dc"|| partsMsg[0] == "leave"){
        voice_Connection.disconnect();
        texto = false;
        voice_Connection = null;
        message = null;
        recording = false;
        usuario = null;
        waitingForResponse = false;
        return;
    }

    if(recording)
        return msg.delete();

    partsMsg.shift();
    pregunta = "";
    partsMsg.forEach(parte => pregunta+=parte+" ");
    console.log(pregunta);
    client.config.assistant.conversation.textQuery = pregunta;
    message = msg;
    //Define el modo de respuesta según el estado de quien pregunta
    texto = !msg.member.voice.channelID;
    if(!texto){
        startRecording = true;
        recording = true;
        await connect(msg);
    }
    client.assistant.start(client.config.assistant.conversation, startConversation);        
});
const connect = async (msg) => {
    try {
        let voice_Channel = msg.member.voice.channel;
        voice_Connection = await voice_Channel.join();
        voice_Connection.play('./sounds/join.wav', { volume: 0.5 });
        speakDetector(voice_Connection)
        voice_Connection.on('disconnect', async(e) => {
            if (e) console.log(e);
        })
    } catch (e) {
        console.log('connect: ' + e)
        msg.reply('Error: unable to join your voice channel.');
        throw e;
    }
    return;
}

const speakDetector = (voice_Connection) => {
    voice_Connection.on('speaking', async (user, speaking) => {
        if (speaking.bitfield == 0 || user.bot || (waitingForResponse && (usuario != user.username)))
            return;
        console.log(`Escuchando a ${user.username}`);
        // this creates a 16-bit signed PCM, stereo 48KHz stream
        const audioStream = voice_Connection.receiver.createStream(user, { mode: 'pcm' });
        audioStream.on('error',  (e) => { 
            console.log('audioStream: ' + e);
        });
        let buffer = [];
        audioStream.on('data', (data) => {
            buffer.push(data);
        })
        audioStream.on('end', async () => {
            buffer = Buffer.concat(buffer);
            const duration = buffer.length / 48000 / 4;
            if (duration < client.config.min_speaking_length || duration > client.config.max_speaking_length) {
                console.log("TOO SHORT / TOO LONG; SKIPPING");
                return;
            }

            try {
                let new_buffer = await convertAudio(buffer);
                let out = await transcribeWitai(new_buffer);
                if (out != null)
                    processCommandsQuery(out, user.username);
            } catch (e) {
                console.log('tmpraw rename: ' + e);
            }
        })    
    })
}
const processCommandsQuery = (query, username) => {    
    if (!query || !query.length)
        return;
    if(waitingForResponse && usuario == username){
        startRecording = true;
        recording = true;
        client.config.assistant.conversation.textQuery = query;
        return client.assistant.start(client.config.assistant.conversation, startConversation);        
    }
    query = query.toLowerCase(); 
    query = query.replaceAll("?","").replaceAll("¿","").replaceAll("!","").replaceAll("¡","");
    console.log("Query: "+query);

    if (query && query.length) {
        talkCommands = client.config.talk_commands.split("-");
        talkCommands.forEach((command) => {
            if(query.includes(command.toLowerCase())){
                voice_Connection.play('./sounds/okgoogle.wav', { volume: 0.5 });
                usuario = username;
                waitingForResponse = true;
            }
        });
    }   
}

// WitAI
let witAI_lastcallTS = null;
const transcribeWitai = async (buffer) => {
    try {
        // ensure we do not send more than one request per second
        if (witAI_lastcallTS != null) {
            let now = Math.floor(new Date());    
            while (now - witAI_lastcallTS < 1000) {
                console.log('sleep')
                await sleep(100);
                now = Math.floor(new Date());
            }
        }
    } catch (e) {
        console.log('Transcripción:' + e)
    }

    try {
        console.log('Transcribiendo...');
        const extractSpeechIntent = util.promisify(witClient.extractSpeechIntent);
        var stream = Readable.from(buffer);
        const contenttype = "audio/raw;encoding=signed-integer;bits=16;rate=48k;endian=little";
        var output = await extractSpeechIntent(client.config.wit_ai_token, stream, contenttype);     
        witAI_lastcallTS = Math.floor(new Date());        

        if(output!=null && output.length) {
            output = "["+( output.replaceAll(/(\r\n|\n|\r)/gm, "").replaceAll("}{", "},{") )+"]";
            outJSON = JSON.parse(output);
            outJSON = outJSON[outJSON.length-1];
            console.log("TL: "+outJSON.text);
            stream.destroy();
            return outJSON.text;
        }     
        return null;
    } catch (e) { console.log('transcribe_witai 851:' + e); console.log(e) }
}

client.login(client.config.discord_token);