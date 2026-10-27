// Disposable synthetic demo DB for UI QA. Production `npm start` is unchanged.
import {createApp} from '../server.js';
const args=process.argv.slice(2),portIndex=args.indexOf('--port'),hostIndex=args.indexOf('--host');
const port=Number(portIndex>=0?args[portIndex+1]:process.env.PORT)||3000;
const host=hostIndex>=0?args[hostIndex+1]:'127.0.0.1';
const {server}=createApp(':memory:');
server.listen(port,host,()=>console.log(`Клинический компас (временные демо-данные): http://${host}:${port}`));
