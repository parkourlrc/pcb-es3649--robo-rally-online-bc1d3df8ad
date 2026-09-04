// import { createBluetooth, type Adapter, type Device, type GattService } from "node-ble";
import { platform } from 'node:os'
import { Characteristic, Peripheral, Service, withBindings } from "@stoprocent/noble"
import type { Character, CharacterID, Player, PlayerID } from "../shared/models/player"
import { ActionFrame, BotMovement, BotState } from "./game_manager/executor";
import type { MovementExecutor } from "./game_manager/executor";
import type { OrientedPosition } from "./game_manager/move_processors";
import type { BotInitializer } from "./game_manager/initializers";
import { Board } from "./game_manager/board";
import { DualKeyMap } from "./game_manager/graph";

// auto-select bluetooth bindings based on platform, specifying dbus for linux
const noble = platform() == 'darwin' ? withBindings('mac') : withBindings('dbus', {
    adapterID: 'hci0'
})

/** a timeout value (ms) */
const TIMEOUT = 15000
const CONTROL_SERVICE_ID                = "346642f1-0000-49fc-a6a6-8a782eb06f26"
const STATE_CHARACTERISTIC              = "346642f1-0001-49fc-a6a6-8a782eb06f26"
const SOUND_CHARACTERISTIC              = "346642f1-0002-49fc-a6a6-8a782eb06f26"
const MOVEMENT_DIRECTION_CHARACTERISTIC = "346642f1-0003-49fc-a6a6-8a782eb06f26"
const IDEMPOTENCY_CHARACTERISTIC        = "346642f1-0004-49fc-a6a6-8a782eb06f26"
const RFID_CHARACTERISTIC               = "346642f1-0005-49fc-a6a6-8a782eb06f26"

const ALL_CHARACTERISTICS: readonly string[] = [
    STATE_CHARACTERISTIC,
    SOUND_CHARACTERISTIC,
    MOVEMENT_DIRECTION_CHARACTERISTIC,
    IDEMPOTENCY_CHARACTERISTIC,
    RFID_CHARACTERISTIC
]

export class BluetoothManager implements MovementExecutor {
    private static instance: BluetoothManager|undefined
    // each try has a pretty generous timeout window. Increase this if the timeout drops
    private static readonly CONNECTION_RETRIES = 1

    /**
     * gets the instance, creating one if one does not already exist
     * @returns the singleton instance
     */
    public static getInstance() {
        if (BluetoothManager.instance === undefined) {
            BluetoothManager.instance = new BluetoothManager()
        }

        return BluetoothManager.instance
    }

    /**
     * destroy the BluetoothManager instance, releasing its bluetooth resources
     */
    public static async destroy() {
        if (BluetoothManager.instance !== undefined && BluetoothManager.instance.destroyer !== undefined) {
            // shut off all the servers
            for (const [player, device] of BluetoothManager.instance.connections.entries()) {
                await BluetoothManager.instance.stopPositionNotifications(player)
                await device.disconnect()
            }
            BluetoothManager.instance.destroyer()
            BluetoothManager.instance = undefined
        }
    }

    private destroyer: (() => void)|undefined
    // private adapter: Adapter|undefined
    private connections = new Map<CharacterID, Peripheral>()
    private attempting_connections = new Map<CharacterID, boolean>()
    private discovering = false
    private actions_set = new Set<CharacterID>()
    // ensure this is in the range [1,255]. 0 is reserved so the drivers have a default which will
    // never appear, and we always want to be able to store it in a uint8;
    private last_idempotency_code: number = 1

    /**
     * create a BluetoothManager
     */
    constructor () {}

    _getFirst<T>(T_list: T[], id: string, bot_id: string): T {
        if (T_list.length === 0) {
            throw new Error(`[BluetoothManager]: Failed to get service/characteristic with id ${id} on device ${bot_id}`)
        } else if (T_list.length > 1) {
            console.warn(`[BluetoothManager]: found duplicate service/characteristic with id ${id} on device ${bot_id}`)
        }
        return T_list[0]
    }

    /**
     * sets up the bluetooth adapter. This will throw if Bluetooth is not set up correctly
     * 
     */
    async setup(): Promise<void> {
        console.info("[BluetoothManager]: Setting up")
        await noble.waitForPoweredOnAsync()
        console.info("[BluetoothManager]: setup complete")
    }

    /**
     * isDiscovering just returns the value of this.discovering
     * @returns true if the manager is open for discovering
     */
    isDiscovering(): boolean {
        return this.discovering
    }

    /**
     * 
     * Returns a mapping of Device IDs to a boolean indicating whether that device is paired or
     * not. If some devices which are not in use may not have an entry
     * @returns a mapping of device IDs to paring status
     */
    async getConnectionStatuses(): Promise<Map<CharacterID, boolean>> {
        const ret = new Map<CharacterID, boolean>()

        for (const [character_id, peripheral] of this.connections) {
            ret.set(character_id, peripheral.state == "connected")
        }

        return ret
    }

    /**
     * set the bluetooth manager to begin discovering devices. Should be called before connectRobot
     */
    async startDiscovering(): Promise<void> {
        if (!this.discovering) {
            this.discovering = true
            await noble.startScanningAsync()
        }
    }

    /**
     * end adapter discovery
     */
    async stopDiscovering(): Promise<void> {
        if (this.discovering) {
            await noble.stopScanningAsync()
            this.discovering = false
        }
    }

    /**
     * initiate or validate bluetooth connection to a robot
    * @param name the name/ID of the bot to connect to
    * @returns true if the bot is connected
    */
    async connectRobot(bot: Character, retries:number=0): Promise<boolean> {
        // check if the bot is already connected
        if (this.connections.has(bot.id)
            && this.connections.get(bot.id)?.state == "connected") {
            // if so, do nothing else
            return true
        }

        // check if a connection attempt is in progress
        // If retries is > 0 it should be true, so don't check
        if (retries === 0
            && this.attempting_connections.has(bot.id) 
            && this.attempting_connections.get(bot.id)) {
            return true
        }

        // try to establish a connection
        const retry_message = retries ? ` (retry #${retries} of ${BluetoothManager.CONNECTION_RETRIES})` : ''
        console.log(`[BluetoothManager]: Attempting bluetooth connection to ${bot.name}${retry_message}`)
        if (!this.discovering) {
            console.log("[BluetoothManager]: can't connect while not discovering!")
            return false
        }
    
        // try to connect to the device
        this.attempting_connections.set(bot.id, true)
        try {
            // const device = await this.adapter.waitDevice(bot.bluetooth_id, TIMEOUT)
            const peripheral = await noble.connectAsync(bot.id)

            // make sure that we have the correct services
            const services = await peripheral.discoverServicesAsync([CONTROL_SERVICE_ID])
            if (services.length === 0) {
                console.error(`[BluetoothManager]: Device with ID ${bot.id} does not have the control service`)
                peripheral.disconnectAsync()
                return false
            }

            // check that the correct characteristics are present
            const characteristic_IDs = (await services[0].discoverCharacteristicsAsync()).map((char: Characteristic) => char.uuid)
            for (const characteristic of ALL_CHARACTERISTICS) {
                // track missing so we get a full listing of missing characteristics
                // It will make debugging nicer
                let missing = false
                if (!(characteristic in characteristic_IDs)) {
                    console.error(`[BluetoothManager]: Device with id ${bot.id} is missing characteristic ${characteristic}`)
                    missing = true
                }
                if (missing) {
                    peripheral.disconnectAsync()
                    return false
                }
            }

            // save the device internally
            this.connections.set(bot.id, peripheral)

            // set the initial state
            this.setMode(bot.id, BotState.SHUTDOWN)
        } catch (error) {
            console.error(`[BluetoothManager]: error connecting to ${bot.name}`, error)
            if (retries < BluetoothManager.CONNECTION_RETRIES) {
                return this.connectRobot(bot, retries + 1)
            }
            return false
        } finally {
            this.attempting_connections.set(bot.id, false)
        }

        console.log(`[BluetoothManager]: connected to ${bot.name}`)

        return true
    }

    /**
     * helper method to get the Gatt Service from the device stores on the connection manager
     * @param bot_id the id of the player to get the gatt service for
     * @returns the GattService for this player's BLE connection
     */
    private async getService(bot_id: CharacterID): Promise<Service|undefined> {
        const peripheral = this.connections.get(bot_id)
        if (peripheral === undefined) {
            return undefined
        }

        try {
            const services = await peripheral.discoverServicesAsync([CONTROL_SERVICE_ID])
            return this._getFirst(services, CONTROL_SERVICE_ID, bot_id)
        } catch (error) {
            console.error(`[BluetoothManager]: Failed to get gatt service: ${CONTROL_SERVICE_ID}`, error)
            return undefined
        }
    }

    /**
     * move the identified bot by performing the given movements
     * @param botID the id of the bot to send the command to
     * @param movement the movements the bot should perform
     */
    async setAction(bot_id: CharacterID, action: ActionFrame): Promise<void> {
        console.log(`[BluetoothManager]: sending movement to ${bot_id}`)

        // check which attributes are set on the given ActionFrame
        if (ActionFrame.isEmpty(action)) {
            // there's nothing to do here
            return
        }

        // add that this player has an action set
        this.actions_set.add(bot_id)

        // get the service
        const service = await this.getService(bot_id)
        if (service === undefined) {
            // TODO error handling, is the character disconnected?
            return
        }

        if (action.pre_action !== undefined) {
            console.log(`[BluetoothManager]: execution for pre-action is not implemented: ${action.pre_action}`)
            // const action_characteristic = await service.getCharacteristic(SOUND_CHARACTERISTIC)
            // await action_characteristic.writeValue(Buffer.from(action.pre_action))
        }

        if (action.end_state !== undefined) {
            await this.setMode(bot_id, action.end_state, service)
        }
        
        // always write the movement in case it is now undefined (meaning no movement), but wasn't
        // previously. Writing a new idempotency code without zeroing it would re-trigger the previous
        // movement
        const found = await service.discoverCharacteristicsAsync([MOVEMENT_DIRECTION_CHARACTERISTIC])
        const movement_characteristic = this._getFirst<Characteristic>(found, MOVEMENT_DIRECTION_CHARACTERISTIC, bot_id)
        const le_move = action.movement || BotMovement.NONE
        await movement_characteristic.writeAsync(Buffer.from([le_move]), true)
    }

    async unlatchActions(): Promise<void> {
        // we will use idempotency codes on a broadcasting channel. When this value is changed,
        // we will have the GattClient read their movement values and execute them once, then
        // wait for a new status change.
        console.log('[BluetoothManager]: unlatching movements')
        if (this.last_idempotency_code >= 255) {
            // never set the code to be 0. 0 is reserved for a default value in the drivers so that
            // any initial value will still trigger a change
            this.last_idempotency_code = 1
        } else {
            this.last_idempotency_code++
        }

        for (const player of this.actions_set) {

            const service = await this.getService(player)
            if (service === undefined) {
                console.error("[BluetoothManager]: Failed to get service for", player)
                continue
            }
            const found = await service.discoverCharacteristicsAsync([IDEMPOTENCY_CHARACTERISTIC])
            const idempotency_characteristic = this._getFirst(found, IDEMPOTENCY_CHARACTERISTIC, player)
            idempotency_characteristic.writeAsync(Buffer.from([this.last_idempotency_code]), false)
        }

        this.actions_set.clear()
    }

    /**
     * starts receiving notifications from the bot with RFIDs read. This will continue, and the call back will be called
     * on any value change until stopPositionNotifications is called
     * @param bot_id the id of the player we will watch for positions on
     * @param callback the function we will call when the position value changes
     */
    private async startPositionNotifications(bot_id: CharacterID, callback: (buffer: Buffer) => void): Promise<void> {
        console.log(`[BluetoothManager]: starting spawn location notifications for ${bot_id}`)

        const service = await this.getService(bot_id)
        if (service === undefined) {
            console.warn(`TODO: better error handling: failed to get service for ${bot_id}`)
            return
        }
        
        // subscribe to notifications
        const found = await service.discoverCharacteristicsAsync([RFID_CHARACTERISTIC])
        const characteristic = this._getFirst(found, RFID_CHARACTERISTIC, bot_id)
        characteristic.subscribeAsync()
        characteristic.on('data', (data: Buffer, isNotification:boolean) => {
            if (isNotification) {
                callback(data)
            }
        })

        // set the state to RFID read so that these values start getting read
        this.setMode(bot_id, BotState.GET_POSITION, service)
    }

    /**
     * releases the notifier on the position characteristic for the player with the given ID
     * @param player_id the id of the player to stop getting notifications for
     */
    private async stopPositionNotifications(player_id: CharacterID): Promise<void> {
        const service = await this.getService(player_id)
        if (service === undefined) {
            console.warn(`TODO: better error handling: failed to get service for ${player_id}`)
            return
        }

        // set the state back to default
        this.setMode(player_id, BotState.DEFAULT)

        // unsubscribe
        const found = await service.discoverCharacteristicsAsync([RFID_CHARACTERISTIC])
        const characteristic = this._getFirst(found, RFID_CHARACTERISTIC, player_id)
        characteristic.unsubscribeAsync()
    }

    /**
     * gets the the position of an actor. In this case, it wraps the callback, making calls to start
     * and stopPositionNotifications, forwarding all notifications through the callback. Once the
     * callback indicates that the position is acceptable, we stop notifications
     * @param bot_id the id of the player to get the position of
     * @param callback the callback function for setting the position. It should return true if the
     * position given is acceptable and no more positions are needed
     */
    async getPosition(bot_id: CharacterID, callback: (position_id: string) => void): Promise<void> {
        const callback_wrapper = (data_buffer: Buffer): void => {
            const decoder = new TextDecoder('UTF-8')
            callback(decoder.decode(data_buffer))
        }

        this.startPositionNotifications(bot_id, callback_wrapper)
    }

    /**
     * wraps stopPositionNotifications, provided to implement MovementExecutor
     * @param bot_id the id of the player whose position is now set, and no longer needs to
     * receive position updates
     */
    async positionSet(bot_id: CharacterID): Promise<void> {
        await this.stopPositionNotifications(bot_id)
    }

    /**
     * sets the BLE characteristic for the bot state to the specified value for the specified player's bot
     * @param bot_id the id of the player whose bot will have the state set
     * @param mode the state to set
     */
    async setMode(bot_id: CharacterID, mode: BotState, service?: Service): Promise<void> {
        if (service === undefined) {
            service = await this.getService(bot_id)
        }
        if (service === undefined) { // still...
            console.warn(`TODO: failed to get service for ${bot_id}`)
            return
        }
        const found = await service.discoverCharacteristicsAsync([STATE_CHARACTERISTIC])
        const characteristic = this._getFirst(found, STATE_CHARACTERISTIC, bot_id)
        characteristic.writeAsync(Buffer.from([mode]), false)
    }
}

/**
 * Initializes bots over bluetooth connections
 */
export class BluetoothBotInitializer implements BotInitializer {
    private priority_list: Player[]
    private connecting: number = 0
    private initial_positions = new Map<PlayerID, OrientedPosition>()
    private used_positions = new DualKeyMap<number, boolean>()
    private board: Board

    public constructor(board: Board, priority_list: Player[]) {
        this.board = board,
        this.priority_list = priority_list
    }

    /**
     * connect the next bot in the priority order, and notify the player that it is their
     * turn to select a position
     */
    public async connectCurrent(): Promise<void> {
        const cur = this.priority_list[this.connecting]
        // make sure a Bluetooth connection is established
        if (!await BluetoothManager.getInstance().connectRobot(cur.character)) {
            throw new Error(`
                Failed to establish Bluetooth connection with: ${cur.name}'s bot`)
        }
        
        // notify the player that their bot is ready to place
        // TODO
    }

    /**
     * Gets the bluetooth apparatuses set up so that we are ready to establish
     * connections
     */
    public async setup(): Promise<void>{
        await BluetoothManager.getInstance().setup()
        await BluetoothManager.getInstance().startDiscovering()

        // begin connecting bots, but don't block
        for (const bot of this.priority_list) {
            BluetoothManager.getInstance().connectRobot(bot.character).catch()
        }
    }

    /**
     * note that the software is finished setting up new bluetooth connections,
     * takes the system out of discovery mode
     */
    public async finished(): Promise<void> {
        await BluetoothManager.getInstance().stopDiscovering()
    }

    /**
     * gets the id of the next player who needs to select a position. if all players have
     * selected, it returns undefined. It also begins notifications for the bluetooth module
     * so whenever a position is set, we read the new value automatically
     * @returns the id of the next player
     */
    public nextPlayer(): PlayerID | undefined {
        // check if we are finished yet
        if (this.connecting < this.priority_list.length) {
            // get the id of the next bot that we need to get a position for
            const cur = this.priority_list[this.connecting].character.id
            this.connectCurrent().then(() => {
                BluetoothManager.getInstance().getPosition(cur, (position_id: string) => {
                    // look up the position on the board
                    const pos = this.board.getSpawnLocation(position_id)
                    if (pos !== undefined) {
                        // check out current position
                        const used = this.initial_positions.get(cur)
                        if (used !== undefined) {
                            this.used_positions.delete(used.x, used.y)
                        }
                        if (this.used_positions.has(pos.x, pos.y)) {
                            // this is a problem, can't use a used position
                            // unset any position
                            this.initial_positions.delete(cur)
                            return
                        }
                        // set the position
                        this.initial_positions.set(cur, pos)
                        this.used_positions.set(pos.x, pos.y, true)
                    }
                })
            })
            return cur
        }

        return undefined
    }

    /**
     * stops notifications for position changes and advances the "current player" to the
     * next player
     */
    public async readPlayerPosition(): Promise<void> {
        const cur = this.priority_list[this.connecting].id
        // if there's no position, we keep waiting
        if (!this.initial_positions.has(cur)) {
            return
        }
        // read the position from the bluetooth characteristic
        BluetoothManager.getInstance().positionSet(cur)
        this.connecting++
    }

    /**
     * returns a map of all players' starting positions
     * @returns the map of all players' starting positions
     */
    public getStartingPositions(): Map<PlayerID, OrientedPosition> {
        return this.initial_positions
    }
}
