import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { typeormDataSourceFactory, typeormOptionsFactory } from "./config/typeorm";
import { RedisModule } from "./config/redis";
import { HttpModule } from "@nestjs/axios";
import { ScheduleModule } from "@nestjs/schedule";
import { TagsModule } from './tags';
import { GithubModule } from './github';
import { UsersModule } from './users';
import { AuthModule } from './auth';
import { PostsModule } from './posts';
import { AppController } from './app.controller';
import { join } from "node:path";
import { DynamooseModule } from "nestjs-dynamoose";
import { dynamooseModuleOptionsFactory } from "./config/dynamoose";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: join(__dirname, "..", ".env")
    }),
    TypeOrmModule.forRootAsync({
      useFactory: typeormOptionsFactory,
      dataSourceFactory: typeormDataSourceFactory,
      inject: [ConfigService]
    }),
    DynamooseModule.forRootAsync({
      useFactory: dynamooseModuleOptionsFactory,
      inject: [ConfigService]
    }),
    HttpModule.register({ global: true }),
    ScheduleModule.forRoot(),
    RedisModule,
    TagsModule,
    GithubModule,
    UsersModule,
    AuthModule,
    PostsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
