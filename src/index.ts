import {EventBus} from "./event-bus";

export enum Ordered {
    HIGHEST_PRECEDENCE = -999999999,
    DEFAULT = 0,
    LOWEST_PRECEDENCE = 999999999,
}

export function ORDER(order: number) {
    return function (target: any) {
        setMetadata(target.prototype, {order});
        return target;
    }
}

export function WIRED(target: any, key: string) {
    const {wired = []} = getMetadata(target);
    setMetadata(target, {
        wired: [
            ...wired,
            key,
        ]
    });
}


export function getMetadata(target: any): any {
    if (target.$metadata)
        return target.$metadata;
    return {};
}

export function setMetadata(target: any, value: any) {
    Object.defineProperty(target, '$metadata', {
        configurable: true,
        enumerable: false,
        writable: false,
        value: {
            ...getMetadata(target),
            ...value,
        }
    });
}

export async function invoke(context: Manager, target: any, name: string, ...args: any[]) {
    const {id} = getMetadata(target.prototype);
    const service = context.systems[id];
    return await service[name].apply(service, args);
}

export async function invokeAll(context: Manager, type: 'linear' | 'parallel' | 'all' | 'race', name: string, ...args: any[]) {
    const pm = context.systems.reduce((acc, service) => {
        const {order = 0, id} = getMetadata(service);
        if (typeof service[name] === 'function') {
            acc.push([id, order, service]);
        }
        return acc;
    }, []).sort((a: any, b: any) => a[1] - b[1]);
    const result: any = {};
    if (type === 'linear') {
        for (let obj of pm) {
            result[obj[0]] = await obj[2][name].apply(obj[2], args);
        }
    } else if (type === 'parallel') {
        const a = await Promise.all(pm.map(obj => obj[2][name].apply(obj[2], args)));
        pm.forEach((obj, i) => {
            result[obj[0]] = a[i];
        })
    } else if (type === 'race') {
        return await Promise.race(pm.map(obj => obj[2][name].apply(obj[2], args)));
    } else if (type === 'all') {
        for (let obj of pm) {
            obj[2][name].apply(obj[2], args);
        }
    }
    return result;
}


function registerSystem(container: Manager, service: any) {
    const {wired = []} = getMetadata(service);
    Object.defineProperty(service, '$manager', {
        value: container,
        configurable: false,
        enumerable: false,
        writable: false,
    });
    service.constructor(container);
    wired.forEach(key => {
        const {id} = getMetadata(service[key].prototype);
        service[key] = container.systems[id];
    });
}

export function PICK<T>(target: { new(manager?: Manager): T }, base?: any): T {
    if (!!base) {
        const meta = getMetadata(target.prototype);
        if (!!base.$manager) {
            return base.$manager.systems[meta.id];
        }
        return null;
    } else {
        return Object.create(target);
    }
}


const Context = {
    components: [],
    systems: [],
};

export function COMPONENT(target) {
    const id = Context.components.length;
    Context.components[id] = target;
    setMetadata(target.prototype, {id, channel: new EventBus()});
    Object.defineProperty(target.prototype, '$id', {
        configurable: false,
        enumerable: true,
        writable: false,
        value: id,
    });
    return target;
}


export function SYSTEM(target) {
    const id = Context.systems.length;
    Context.systems[id] = target;
    setMetadata(target.prototype, {id, channel: new EventBus()});
    Object.defineProperty(target.prototype, '$id', {
        configurable: false,
        enumerable: true,
        writable: false,
        value: id,
    });
    return target;
}

export class Entity {
    id: number;
    name: string;
    manager: Manager;
    components: number[];

    addComponent(type: any, options: any) {
        const {id} = getMetadata(type.prototype);
        if (this.components[id]) {
            throw new Error(this.name + ' already have ' + type.prototype.name)
        }
        this.components[id] = options;
        return this;
    }

    getComponent<T>(type: { new(): T }): T {
        const {id} = getMetadata(type.prototype);
        if (!this.components[id]) {
            return null;
        }
        return this.components[id] as any;
    }
}

export class System {
    $manager: Manager;
}

export class Manager {
    index = 0;
    entities: Entity[];
    systems: any[];
    updates: EventBus;
    channel: EventBus;

    constructor() {
        this.entities = [];
        this.updates = new EventBus();
        this.channel = new EventBus();
        this.systems = Context.systems.map(cls => Object.create(cls.prototype));
        for (let i = 0; i < this.systems.length; i++) {
            registerSystem(this, this.systems[i]);
        }
    }

    pick = (target) => {
        const meta = getMetadata(target.prototype);
        return this.systems[meta.id];
    };

    broadcast = (...args) => this.channel.dispatch(...args);
    invoke = async (target, name, ...args) => await invoke(this, target, name, ...args);
    invokeAll = async (name, ...args) => await invokeAll(this, 'all', name, ...args);
    invokeLinear = async (name, ...args) => await invokeAll(this, 'linear', name, ...args);
    invokeParallel = async (name, ...args) => await invokeAll(this, 'parallel', name, ...args);
    invokeRace = async (name, ...args) => await invokeAll(this, 'race', name, ...args);

    createEntity(name: string) {
        const entity = new Entity();
        entity.id = this.index++;
        entity.name = name;
        entity.manager = this;
        entity.components = [];
        this.entities.push(entity);
        return entity;
    }

    filter(type: any) {
        const {id} = getMetadata(type.prototype);
        return this.entities.filter(a => {
            return !!a.components[id];
        });
    }

    run = async () => {
        await this.invokeLinear('create');
        await this.invokeParallel('run');

    }
}