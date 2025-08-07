import { ConfigService } from "@nestjs/config";
import { DynamooseModuleOptions } from "nestjs-dynamoose";

export function dynamooseModuleOptionsFactory(
    config: ConfigService
): DynamooseModuleOptions {

    return {
        aws: {
            accessKeyId: config.get<string>("AWS_ACCESS_KEY_ID"),
            secretAccessKey: config.get<string>("AWS_SECRET_ACCESS_KEY"),
            region: config.get<string>("AWS_REGION"),
        },
        local: config.get<string>("NODE_ENV") !== "dev",
    };
}